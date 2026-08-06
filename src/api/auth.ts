import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

/**
 * Bearer-token authentication.
 *
 * A deployment would front this with the issuer's OIDC provider; tokens remain
 * for service accounts and for the ingestion workers. The security properties
 * that matter are the same either way: the secret is never stored, lookup is
 * constant-shape, and executive signing needs proof of presence rather than a
 * live session.
 */

export const USER_ROLES = [
  'VIEWER',
  'PREPARER',
  'COMPLIANCE',
  'CFO',
  'CEO',
  'ADMIN',
] as const;

export type UserRole = (typeof USER_ROLES)[number];

export interface Principal {
  readonly userId: string;
  readonly email: string;
  readonly issuerId: string;
  readonly roles: readonly UserRole[];
  /** True when a WebAuthn step-up completed recently enough to sign. */
  readonly stepUpVerified: boolean;
  readonly tokenId: string;
}

/** How recently a step-up must have happened for an executive signature. */
export const STEP_UP_VALIDITY_MS = 5 * 60 * 1000;

/**
 * How far in the future a step-up stamp may sit and still be believed.
 *
 * The window needs a floor as well as a ceiling. `now - stamp < WINDOW` alone is
 * satisfied by *any* future stamp, so a clock that runs ahead of the one doing
 * the comparison turns a five-minute proof of presence into an open-ended one.
 * Kept small: instances are NTP-synced and the stamp is written by the same
 * process clock that reads it, so anything beyond a few seconds is a fault
 * rather than skew.
 */
export const STEP_UP_CLOCK_SKEW_MS = 5_000;

export interface IssuedToken {
  readonly tokenId: string;
  /** Shown once. Never stored, never logged, never recoverable. */
  readonly token: string;
}

/**
 * Hash a bearer token for storage and lookup.
 *
 * Plain SHA-256 rather than a password hash: the token is 32 bytes of CSPRNG
 * output, so there is no dictionary or guess space for a slow KDF to defend, and
 * the cost would land on every authenticated request.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateToken(): string {
  // 32 bytes, base64url. Prefixed so a leaked credential is greppable in logs
  // and recognisable by secret scanners.
  return `rsos_${randomBytes(32).toString('base64url')}`;
}

/** Extract a bearer token from an Authorization header. */
export function parseBearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

interface TokenRow {
  token_id: string;
  user_id: string;
  email: string;
  issuer_id: string;
  roles: UserRole[];
  active: boolean;
  step_up_at: Date | null;
  expires_at: Date;
  revoked_at: Date | null;
}

export class Authenticator {
  constructor(
    private readonly pool: pg.Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Resolve a bearer token to a principal, or null.
   *
   * Runs outside `withTenant` because the tenant is derived from the token —
   * `users` and `api_tokens` deliberately carry no RLS policy for this reason
   * (migration 006). Everything after this point is tenant-scoped.
   */
  async authenticate(token: string | null): Promise<Principal | null> {
    if (token === null || token === '') return null;

    const { rows } = await this.pool.query<TokenRow>(
      // `u.roles::text[]` is load-bearing. The driver has no parser for an array
      // of a custom enum, so `u.roles` arrives as the literal string
      // '{PREPARER}' — and `String.prototype.includes` then answers role checks
      // by SUBSTRING match. That silently grants any role whose name is a
      // substring of a held one. Casting to text[] gives a real JS array.
      `SELECT t.id AS token_id, u.id AS user_id, u.email, u.issuer_id,
              u.roles::text[] AS roles, u.active,
              t.step_up_at, t.expires_at, t.revoked_at
         FROM api_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1`,
      [hashToken(token)],
    );

    const row = rows[0];
    if (row === undefined) return null;
    if (!row.active) return null;
    if (row.revoked_at !== null) return null;

    // Defence against the cast above being dropped in a later edit: a string
    // here would make every role check a substring test.
    if (!Array.isArray(row.roles)) {
      throw new TypeError('user roles did not decode to an array; check the ::text[] cast');
    }

    const now = this.now().getTime();
    if (row.expires_at.getTime() <= now) return null;

    // Bounded on BOTH sides. A stamp dated after the moment we are checking it
    // did not happen five minutes ago, whatever the arithmetic says, and the
    // upper bound alone would accept it forever.
    const stepUpAge = row.step_up_at === null ? null : now - row.step_up_at.getTime();
    const stepUpVerified =
      stepUpAge !== null && stepUpAge > -STEP_UP_CLOCK_SKEW_MS && stepUpAge < STEP_UP_VALIDITY_MS;

    return {
      userId: row.user_id,
      email: row.email,
      issuerId: row.issuer_id,
      roles: row.roles,
      stepUpVerified,
      tokenId: row.token_id,
    };
  }

  /** Issue a token for a user. The plaintext is returned exactly once. */
  async issueToken(params: {
    userId: string;
    name: string;
    expiresAt: Date;
  }): Promise<IssuedToken> {
    const token = generateToken();
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO api_tokens (user_id, name, token_hash, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [params.userId, params.name, hashToken(token), params.expiresAt],
    );
    return { tokenId: rows[0]!.id, token };
  }

  async revokeToken(tokenId: string): Promise<void> {
    await this.pool.query(
      `UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [tokenId],
    );
  }

  /**
   * Record a completed step-up, starting the short window for signing.
   *
   * Stamped from `this.now()` rather than SQL `now()`, because `authenticate`
   * measures the age of this stamp against `this.now()`. Writing one clock and
   * reading another makes the freshness window as long as the skew between the
   * database host and the API host — in the wrong direction, unbounded.
   */
  async recordStepUp(tokenId: string): Promise<void> {
    await this.pool.query(`UPDATE api_tokens SET step_up_at = $2 WHERE id = $1`, [
      tokenId,
      this.now(),
    ]);
  }

  /** Best-effort usage stamp; never blocks or fails a request. */
  async touch(tokenId: string): Promise<void> {
    try {
      await this.pool.query(`UPDATE api_tokens SET last_used_at = now() WHERE id = $1`, [tokenId]);
    } catch {
      // Observability only.
    }
  }
}

export function hasRole(principal: Principal, ...roles: readonly UserRole[]): boolean {
  return roles.some((role) => principal.roles.includes(role));
}
