import type { FastifyInstance } from 'fastify';
import { inPublicRole, type AppContext } from '../server.js';
import { canonicalize, merkleRoot, sha256Hex } from '../../domain/canonical.js';
import { buildPublicDisclosure } from '../../domain/report.js';
import { badRequest, notFound } from '../errors.js';
import type { CanonicalValue } from '../../domain/canonical.js';

/**
 * Public verification.
 *
 * Unauthenticated by design: a disclosure nobody can check without an account
 * is not a disclosure. The connection runs as `reserveos_public`, whose policies
 * restrict it to PUBLISHED periods, so a mistake in this handler cannot expose a
 * draft — the database refuses regardless of what the query asks for.
 *
 * This endpoint deliberately does NOT return a `verified: true` field. A server
 * asserting its own correctness proves nothing; the client is expected to
 * recompute every hash from the payload it received. Everything needed to do
 * that is in the response.
 */

const HASH_SHAPE = /^[0-9a-f]{64}$/;

/**
 * Deepest structure `/verify/canonicalize` will accept.
 *
 * A report payload nests about six levels; a public disclosure fewer. A hundred
 * is far more headroom than any real document needs and far less than the
 * ~5000 frames at which the recursive serializer runs out of stack.
 */
const MAX_CANONICALIZE_DEPTH = 100;

/**
 * Reject over-deep structures without recursing.
 *
 * An explicit stack, because a recursive depth check on adversarial input
 * overflows in exactly the place it was added to protect.
 */
function assertDepthWithin(root: unknown, limit: number): void {
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 1 }];

  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (node === null || typeof node !== 'object') continue;
    if (depth > limit) {
      throw badRequest(`JSON nesting deeper than ${limit} levels is not accepted`);
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      stack.push({ node: child, depth: depth + 1 });
    }
  }
}

interface VersionRow {
  version_id: string;
  payload: unknown;
  payload_hash: string;
  generated_at: Date;
  version: number;
  period_id: string;
  period_start: Date;
  period_end: Date;
}

interface AnchorRow {
  merkle_root: string;
  besu_tx_hash: string | null;
  besu_block_number: string | null;
  anchored_at: Date | null;
  status: string;
  public_tether_ref: string | null;
}

export function registerVerifyRoutes(app: FastifyInstance, context: AppContext): void {
  app.get<{ Params: { hash: string } }>('/verify/:hash', async (request, reply) => {
    const hash = request.params.hash.toLowerCase();
    if (!HASH_SHAPE.test(hash)) {
      throw badRequest('hash must be 64 lowercase hex characters');
    }

    const found = await inPublicRole(context, async (client) => {
      // Resolves the CERTIFIED REPORT hash only — the value printed on the
      // published report. A disclosure hash cannot be resolved here: it is
      // derived from the payload rather than stored, so matching one would mean
      // scanning every published version and canonicalizing each, on an
      // unauthenticated endpoint. Supporting it needs an indexed
      // `report_versions.disclosure_hash` written at generation time.
      const { rows } = await client.query<VersionRow>(
        `SELECT v.id AS version_id, v.payload, v.payload_hash, v.generated_at, v.version,
                p.id AS period_id, p.period_start, p.period_end
           FROM report_versions v
           JOIN reporting_periods p ON p.id = v.period_id
          WHERE v.payload_hash = $1`,
        [hash],
      );

      const row = rows[0];
      if (row === undefined) return null;

      const anchors = await client.query<AnchorRow>(
        `SELECT merkle_root, besu_tx_hash, besu_block_number, anchored_at, status,
                public_tether_ref
           FROM anchors
          WHERE subject_type = 'REPORT_VERSION' AND subject_id = $1`,
        [row.version_id],
      );

      return { row, anchor: anchors.rows[0] ?? null };
    });

    if (found === null) {
      // Indistinguishable from "exists but unpublished", which is correct: the
      // existence of a draft period is not public information.
      throw notFound('No published report matches that hash');
    }

    const { row, anchor } = found;
    const disclosure = buildPublicDisclosure({
      payload: row.payload as CanonicalValue,
      payloadHash: row.payload_hash,
      canonicalJson: '',
    });

    const expectedCommitment = merkleRoot([row.payload_hash, disclosure.payloadHash]);

    void reply.header('cache-control', 'public, max-age=60');

    return {
      period: {
        start: row.period_start.toISOString().slice(0, 10),
        end: row.period_end.toISOString().slice(0, 10),
        version: row.version,
        generatedAt: row.generated_at.toISOString(),
      },
      /** The published figures. Recompute its hash to confirm it is intact. */
      disclosure: disclosure.payload,
      disclosureHash: disclosure.payloadHash,
      /** Hash of the full certified report, which stays private. */
      certifiedReportHash: row.payload_hash,
      /**
       * What the chain commits to: a Merkle root over the certified report hash
       * and the disclosure hash, in that order. Anchoring the report hash alone
       * would leave the published figures uncommitted — anyone could serve
       * different figures citing the same report.
       */
      commitment: {
        expected: expectedCommitment,
        leaves: [row.payload_hash, disclosure.payloadHash],
        construction: 'sha256 over the concatenated raw bytes of the two leaf digests, in order',
      },
      anchor:
        anchor === null
          ? null
          : {
              merkleRoot: anchor.merkle_root,
              transactionHash: anchor.besu_tx_hash,
              blockNumber: anchor.besu_block_number,
              anchoredAt: anchor.anchored_at?.toISOString() ?? null,
              status: anchor.status,
              publicTetherRef: anchor.public_tether_ref,
            },
      /**
       * The exact bytes hashed to produce `disclosureHash`, so a verifier can
       * check our canonicalization rather than reimplementing it. Recomputing
       * from `disclosure` must produce the same string.
       */
      canonicalJson: canonicalize(disclosure.payload),
      howToVerify: [
        'Start here: confirm `certifiedReportHash` equals the hash printed on the report you were given. Every step below compares this response against itself, so a server that invented the whole document would satisfy all of them. This is the only step that uses a value we did not supply.',
        'Read the figures off `disclosure`. `disclosureHash` covers `disclosure` and nothing else, so the surrounding `period` block, the `anchor` metadata and this list are uncommitted text — confirm the outer `period` block agrees with `disclosure.period` and `disclosure.generatedAt` before quoting either.',
        'Canonicalize `disclosure` (RFC 8785; keys sorted by UTF-16 code unit, no whitespace, no JSON numbers — quantities are decimal strings and absent values are null) and SHA-256 it. It must equal `disclosureHash`. `canonicalJson` is the exact string we hashed, for comparison.',
        'Confirm `disclosure.certifiedReportHash` equals `certifiedReportHash`.',
        'Compute sha256(hexToBytes(certifiedReportHash) || hexToBytes(disclosureHash)). It must equal `commitment.expected`.',
        'Confirm `anchor.merkleRoot` equals `commitment.expected` and that `anchor.status` is CONFIRMED with a non-null `anchor.transactionHash`. A PENDING or FAILED anchor commits nothing.',
        'Finally, look up `anchor.transactionHash` on the ledger yourself and confirm it carries `commitment.expected`. Nothing in this response is evidence that it does.',
      ],
    };
  });

  /** Health endpoint, unauthenticated, exposing nothing about tenants. */
  app.get('/health', async () => ({ status: 'ok' }));

  /**
   * Lets a verifier confirm our canonicalization against their own input.
   *
   * Registered in its own encapsulated scope so it can parse a request body by
   * the same rules the canonicalizers use. Fastify's default parser rejects
   * `__proto__` outright, and every rejection — that one and any malformed body
   * — arrived at the error handler as a plain FastifyError, which `toProblem`
   * turns into a 500 with an error-level log line. So the endpoint that exists
   * to demonstrate our canonicalization answered "Internal Server Error" for a
   * document `canonicalize` handles fine and whose output
   * `test/portal/verify-client.test.ts` pins, and an unauthenticated caller
   * could drive error logging with a single malformed byte.
   *
   * `JSON.parse` makes `__proto__` an ordinary own property and pollutes
   * nothing; the parsed value is only read here — walked for depth, then
   * serialized — and never merged into anything.
   */
  void app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser<string>(
      'application/json',
      { parseAs: 'string' },
      (_request, body, done) => {
        try {
          done(null, JSON.parse(body) as unknown);
        } catch {
          done(badRequest('body is not valid JSON'));
        }
      },
    );

    scope.post('/verify/canonicalize', canonicalizeHandler);
  });
}

async function canonicalizeHandler(request: {
  body: unknown;
}): Promise<{ canonicalJson: string; sha256: string }> {
  const body = request.body;
  if (body === null || typeof body !== 'object') {
    throw badRequest('body must be a JSON object or array');
  }

  // `canonicalize` recurses once per level while V8's JSON parser does not, so
  // 10 KB of '[' parses cleanly and then exhausts the stack. That surfaced as a
  // 400 reading "Maximum call stack size exceeded" — an engine message on an
  // unauthenticated endpoint, from an input this handler should have named as
  // wrong. Checked iteratively so the check itself cannot overflow.
  assertDepthWithin(body, MAX_CANONICALIZE_DEPTH);

  try {
    // Canonicalize once and hash that string, rather than canonicalizing twice.
    const canonicalJson = canonicalize(body as CanonicalValue);
    return { canonicalJson, sha256: sha256Hex(canonicalJson) };
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : 'not canonicalizable');
  }
}
