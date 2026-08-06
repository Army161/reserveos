import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withPublicRole, withTenant } from '../db/pool.js';
import type { KaleidoClient } from '../kaleido/client.js';
import { Authenticator, hasRole, parseBearer, type Principal, type UserRole } from './auth.js';
import { ApiError, badRequest, forbidden, notFound, toProblem, unauthorized } from './errors.js';
import { registerIssuerRoutes } from './routes/issuer.js';
import { registerPeriodRoutes } from './routes/periods.js';
import { registerCertificationRoutes } from './routes/certification.js';
import { registerVerifyRoutes } from './routes/verify.js';

export interface ServerOptions {
  readonly pool: pg.Pool;
  readonly kaleido: KaleidoClient;
  /** Injected so report generation timestamps are deterministic in tests. */
  readonly now?: () => Date;
  readonly fxSource?: string;
  readonly logger?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    correlationId: string;
  }
}

export interface AppContext {
  readonly pool: pg.Pool;
  readonly kaleido: KaleidoClient;
  readonly now: () => Date;
  readonly fxSource: string;
  readonly authenticator: Authenticator;
}

/**
 * Run a handler inside the caller's tenant scope.
 *
 * Every authenticated database access goes through this. The issuer comes from
 * the authenticated principal and never from the request body or a path
 * parameter, so a client cannot ask to act as another tenant — and even if a
 * handler tried, row-level security would return nothing.
 */
export async function inTenant<T>(
  context: AppContext,
  request: FastifyRequest,
  fn: (client: pg.PoolClient, principal: Principal) => Promise<T>,
): Promise<T> {
  const principal = requirePrincipal(request);
  return withTenant(context.pool, principal.issuerId, (client) => fn(client, principal));
}

/** Read-only access for the unauthenticated examiner endpoint. */
export async function inPublicRole<T>(
  context: AppContext,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withPublicRole(context.pool, fn);
}

export function requirePrincipal(request: FastifyRequest): Principal {
  if (request.principal === undefined) throw unauthorized();
  return request.principal;
}

export function requireRole(request: FastifyRequest, ...roles: readonly UserRole[]): Principal {
  const principal = requirePrincipal(request);
  if (!hasRole(principal, ...roles, 'ADMIN')) {
    throw forbidden(`this action requires one of: ${roles.join(', ')}`);
  }
  return principal;
}

/** Parse a request body against a schema, reporting the offending field. */
export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join('.') ?? '<body>';
    throw badRequest(`${path}: ${first?.message ?? 'invalid'}`);
  }
  return result.data;
}

/**
 * Routes that must work without a credential, listed by their registered path.
 *
 * Authentication is skipped entirely for these, rather than merely tolerated:
 * the examiner portal and the verification endpoint are the product's claim that
 * a published report can be checked by anyone, and that claim cannot be
 * contingent on the caller's credential being *valid*. A stale bearer token left
 * on a proxy, an API client or a monitoring agent would otherwise turn public
 * verification and the liveness probe into 401s.
 *
 * Matched against the route pattern Fastify resolved, not the raw URL, so an
 * unmatched or traversal-shaped path falls through to normal authentication.
 * A new public route must be added here; forgetting is fail-safe (it keeps
 * demanding a valid token) rather than fail-open.
 */
const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  '/health',
  '/verify/:hash',
  '/verify/canonicalize',
  '/portal',
  '/portal/verify-client.mjs',
  '/portal/app.mjs',
  // The console's shell must load before the user has a credential — it is what
  // renders the sign-in form. These carry markup and code only; every byte of
  // tenant data still comes from the authenticated /api routes below.
  '/operator',
  '/operator/app.mjs',
  '/operator/api.mjs',
  '/operator/ui.mjs',
]);

export function isPublicRoute(request: FastifyRequest): boolean {
  const pattern = request.routeOptions?.url;
  return pattern !== undefined && PUBLIC_ROUTES.has(pattern);
}

const FASTIFY_CLIENT_ERROR_TITLES: ReadonlyMap<number, string> = new Map([
  [400, 'Bad Request'],
  [404, 'Not Found'],
  [405, 'Method Not Allowed'],
  [406, 'Not Acceptable'],
  [413, 'Payload Too Large'],
  [414, 'URI Too Long'],
  [415, 'Unsupported Media Type'],
  [431, 'Request Header Fields Too Large'],
]);

/**
 * Translate Fastify's own request rejections into the problem model.
 *
 * `toProblem` understands `ApiError` and treats everything else as a 500. But a
 * body Fastify refused to accept — malformed JSON, an unsupported media type, a
 * payload over `bodyLimit` — is the caller's mistake, and it is raised during
 * parsing, before any handler runs and before there is an `ApiError` to raise.
 * Reporting it as 500 is wrong twice over: the caller is told to retry something
 * only they can fix, and the branch below logs every 5xx at error level with a
 * stack, so an unauthenticated caller could drive error logging on any POST
 * route with a single malformed byte.
 *
 * `routes/verify.ts` hit exactly this and worked around it for one endpoint by
 * installing its own content-type parser. The translation belongs here, where it
 * covers every route rather than the one that noticed.
 *
 * Deliberately narrow. Only Fastify's own `FST_ERR_*` codes are trusted, and
 * only their 4xx statuses: those messages describe the request the caller sent
 * and reveal nothing about this system. Anything else — a database error, a bug,
 * any 5xx from any source — falls through and stays opaque.
 */
function fastifyClientError(error: unknown): ApiError | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { code?: unknown; statusCode?: unknown; message?: unknown };

  if (typeof candidate.code !== 'string' || !candidate.code.startsWith('FST_ERR_')) return null;

  const status = candidate.statusCode;
  if (typeof status !== 'number' || status < 400 || status >= 500) return null;

  const title = FASTIFY_CLIENT_ERROR_TITLES.get(status);
  if (title === undefined) return null;

  const detail =
    typeof candidate.message === 'string' && candidate.message !== ''
      ? candidate.message
      : 'The request was rejected.';

  return new ApiError(status, title, detail);
}

export const uuidSchema = z.string().uuid();

export function requireUuid(value: string, name: string): string {
  const result = uuidSchema.safeParse(value);
  if (!result.success) throw badRequest(`${name} must be a UUID`);
  return result.data;
}

export function createServer(options: ServerOptions): FastifyInstance {
  const context: AppContext = {
    pool: options.pool,
    kaleido: options.kaleido,
    now: options.now ?? (() => new Date()),
    fxSource: options.fxSource ?? 'ECB',
    authenticator: new Authenticator(options.pool, options.now),
  };

  const app = Fastify({
    logger: options.logger ?? false,
    // Reject oversized bodies early: report payloads are the large objects here
    // and they are generated server-side, never uploaded.
    bodyLimit: 1_048_576,
    genReqId: () => randomUUID(),
  });

  app.decorateRequest('principal', undefined);
  app.decorateRequest('correlationId', '');

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    request.correlationId = request.id as string;
    reply.header('x-correlation-id', request.correlationId);

    // Defence in depth for a JSON API that also serves a portal page.
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
  });

  // Authentication runs for every route except the declared public ones;
  // authorization is per route.
  app.addHook('preHandler', async (request: FastifyRequest) => {
    // A public route reads no principal, so there is nothing to authenticate and
    // nothing an unusable token should be able to deny.
    if (isPublicRoute(request)) return;

    const token = parseBearer(request.headers.authorization);
    if (token === null) return;

    const principal = await context.authenticator.authenticate(token);
    if (principal === null) {
      // An invalid token is an explicit failure rather than an anonymous
      // request: silently degrading would turn a stale credential into a
      // confusing 403 further down.
      throw unauthorized('The bearer token is invalid, expired or revoked');
    }
    request.principal = principal;
    void context.authenticator.touch(principal.tokenId);
  });

  app.setErrorHandler((error, request, reply) => {
    const problem = toProblem(fastifyClientError(error) ?? error, request.correlationId);

    if (problem.status >= 500) {
      request.log.error(
        { err: error, correlationId: request.correlationId },
        'unhandled error',
      );
    }

    void reply.status(problem.status).type('application/problem+json').send(problem);
  });

  app.setNotFoundHandler((request, reply) => {
    const problem = toProblem(notFound(), request.correlationId);
    void reply.status(404).type('application/problem+json').send(problem);
  });

  registerIssuerRoutes(app, context);
  registerPeriodRoutes(app, context);
  registerCertificationRoutes(app, context);
  registerVerifyRoutes(app, context);
  registerPortal(app);
  registerOperatorConsole(app);

  return app;
}

/**
 * Serve the examiner portal.
 *
 * Static and dependency-free, and the verification module is served as readable
 * source rather than a bundle: an examiner who is asked to trust a verification
 * result should be able to read the code that produced it.
 */
function registerPortal(app: FastifyInstance): void {
  const portalDir = fileURLToPath(new URL('../portal/', import.meta.url));

  app.get('/portal', async (_request, reply) => {
    void reply.type('text/html; charset=utf-8');
    // No inline-script CSP here would be dishonest: the page ships one module
    // and no third-party code, and locking that down is what makes "read what
    // ran" meaningful.
    void reply.header(
      'content-security-policy',
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    );
    return readFile(join(portalDir, 'index.html'), 'utf8');
  });

  // Explicit allow-list rather than a directory server: the portal directory
  // also holds a type declaration, and a path-joining mistake in a static
  // handler is how a file server becomes a file-read primitive.
  for (const asset of ['verify-client.mjs', 'app.mjs'] as const) {
    app.get(`/portal/${asset}`, async (_request, reply) => {
      void reply.type('text/javascript; charset=utf-8');
      return readFile(join(portalDir, asset), 'utf8');
    });
  }
}

/**
 * Serve the operator console.
 *
 * Static, like the portal, and served under absolute paths. A relative `src` on
 * a page served at `/operator` (no trailing slash) resolves against `/`, so the
 * browser silently requests the wrong URL, the module never loads and the page
 * does nothing at all — no error, no console message. The portal shipped exactly
 * that bug; `test/api/lifecycle.test.ts` now resolves every reference the way a
 * browser would.
 */
function registerOperatorConsole(app: FastifyInstance): void {
  const operatorDir = fileURLToPath(new URL('../operator/', import.meta.url));

  app.get('/operator', async (_request, reply) => {
    void reply.type('text/html; charset=utf-8');
    // `connect-src 'self'` is what keeps an authenticated session's data on this
    // origin: the console holds a bearer token, and a page that could talk to a
    // third party could hand it over.
    void reply.header(
      'content-security-policy',
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    return readFile(join(operatorDir, 'index.html'), 'utf8');
  });

  for (const asset of ['app.mjs', 'api.mjs', 'ui.mjs'] as const) {
    app.get(`/operator/${asset}`, async (_request, reply) => {
      void reply.type('text/javascript; charset=utf-8');
      return readFile(join(operatorDir, asset), 'utf8');
    });
  }
}

export { ApiError };
