import {
  ANCHOR_SUBJECT_ORDINAL,
  uuidToBytes32,
  type AnchorReceipt,
  type AnchorRequest,
  type AnchorSubmission,
  type KaleidoClient,
  type PolicyEvaluation,
  type PolicyRequest,
  type TokenSupplyQuery,
  type TokenSupplyResult,
} from './client.js';

/**
 * The real Kaleido client — an HTTP implementation of `KaleidoClient`.
 *
 * Every request shape below is grounded in one of two verifiable sources, never
 * in a guess:
 *
 *  1. FireFly's own source (`hyperledger-firefly/firefly`, `.../evmconnect`,
 *     `.../common`). FireFly is the open-source engine Kaleido Platform is
 *     built on and self-hosting it is this repo's stated exit from vendor
 *     lock-in (see `KaleidoClient`'s doc comment), so its routes are both
 *     public and load-bearing for that exit to mean anything. `submitAnchor`,
 *     `getAnchorReceipt`, and the value half of `getTokenSupply` are built
 *     directly against routes read from that source — not from Kaleido's own
 *     docs, which 302 to a login and are not paraphrased here from memory.
 *  2. OPA's REST Data API for `evaluatePolicy`. `plan.md` states Kaleido's
 *     Policy Manager is "OPA-based", and OPA's data-plane API
 *     (`POST /v1/data/<path>` → `{"result": ...}`) is the genuinely public,
 *     stable surface underneath whatever convenience routes Kaleido layers on
 *     top. If PMS wraps that differently, `KALEIDO_POLICY_MANAGER_URL` is the
 *     one line that needs to change, not the calling code — see
 *     `certification.ts`, which only trusts `policy.allowed` after its own
 *     four-eyes and step-up checks already passed, so a wrong policy shape
 *     fails a signature rather than corrupting one.
 *
 * What is NOT built here, on purpose:
 *
 *  - Block context for `getTokenSupply`. FireFly's contract-query path is
 *    confirmed (from `evmconnect`'s own `QueryInvoke` source) to return only
 *    the ABI-decoded call result — `ffcapi.QueryInvokeResponse` carries no
 *    block number or timestamp, because `eth_call` itself doesn't return one.
 *    `PgSupplyFactStore` uses `blockNumber` for conflict detection and dedup
 *    (`supply-worker.ts`), so a fabricated value would corrupt exactly the
 *    check this system's own design rule exists to protect: "missing data is
 *    a critical breach, never a zero." `resolveBlockContext` is therefore a
 *    required, separately-injected dependency with no default — it throws
 *    plainly if unconfigured rather than silently guessing.
 *  - `getLatestTetherProof`. Kaleido's Public Ethereum Tether service has no
 *    public API surface I could find grounded in anything (see [[reserveos-project]] memory
 *    — the one archived docs snapshot I have predates the Platform generation
 *    entirely). Configuring `KALEIDO_TETHER_URL` is opt-in; unconfigured
 *    returns `null`, which is what "no proof relay wired up yet" honestly is.
 *
 * build-v1.md §4 calls this out directly: "Public Terraform documentation
 * enumerates the platform_* resources but leaves most service type strings and
 * config_json shapes as passthrough, so those must be read back from a live
 * environment rather than guessed." The same is true of the runtime REST
 * shapes below where they touch Kaleido-proprietary services rather than
 * open-source FireFly/OPA. Treat every `Verify:` comment as a checklist item
 * for week 1's provisioning spike, not as a claim that this has run against a
 * live environment — it has not, because no credentials exist yet.
 */

export interface KaleidoRestClientConfig {
  /**
   * The FireFly node's base REST URL, exactly as Kaleido's console shows it
   * for the provisioned environment — e.g.
   * `https://xxxx-firefly.eu0-aws.kaleido.io`. Environment routing is already
   * baked into this URL by Kaleido, so nothing here appends an environment id.
   */
  readonly apiUrl: string;
  readonly apiKey: string;
  /**
   * `basic`: `Authorization: Basic base64(apiKey:)`, Kaleido's long-standing
   * convention for console-issued API keys — the key as the HTTP Basic
   * username, empty password. `bearer`: `Authorization: Bearer <apiKey>`.
   * Configurable because this is the one credential-handling detail this file
   * cannot verify without a live key to test against; if the spike finds it
   * wrong, it is an env change, not a code change.
   */
  readonly authScheme?: 'basic' | 'bearer';
  /** FireFly namespace for anchor operations. FireFly's own default is 'default'. */
  readonly namespace?: string;
  /** Registered ContractAPI name for EvidenceAnchor. build-v1.md §6.5 names it 'evidenceanchor'. */
  readonly contractApiName?: string;
  /** Signing key passed as `ContractCallRequest.key` — KALEIDO_KMS_KEY_ID verbatim; Kaleido's key resolver accepts either a key id or a resolved address. */
  readonly signingKey: string;
  /**
   * Policy Manager base URL (OPA data-plane host). When unset, `evaluatePolicy`
   * throws rather than fabricating a decision — certification.ts hard-depends
   * on `policy.allowed` to admit a signature.
   */
  readonly policyManagerUrl?: string;
  /** Public Ethereum Tether relay base, if configured. Unset means "not wired up yet", not an error. */
  readonly tetherUrl?: string;
  /**
   * Maps this deployment's `connectorId` (`token_deployments.kaleido_connector_id`)
   * to the FireFly namespace that fronts that chain's EVMConnect connector.
   * Defaults to using `connectorId` as the namespace verbatim, which is one
   * plausible topology among several Kaleido supports — override once the
   * spike confirms the actual one.
   */
  readonly resolveConnectorNamespace?: (connectorId: string) => string;
  /**
   * Resolves the block a `totalSupply()` read was made against. No default
   * that returns a value — see the file header. Omitting this does not stop
   * the server from starting: anchoring and certification do not need it, so
   * it fails only when `getTokenSupply` is actually called, the same way an
   * unconfigured `policyManagerUrl` fails only a signature attempt rather than
   * every request.
   */
  readonly resolveBlockContext?: (connectorId: string) => Promise<{
    readonly blockNumber: bigint;
    readonly blockTimestamp: Date;
  }>;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** Thrown for any non-2xx response this client cannot map to a more specific error. */
export class KaleidoHttpError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`Kaleido ${method} ${path} -> ${status}: ${body.slice(0, 500)}`);
    this.name = 'KaleidoHttpError';
  }
}

/** Raised by `evaluatePolicy` and `getTokenSupply` when required config is absent. */
export class KaleidoNotConfiguredError extends Error {
  constructor(what: string) {
    super(`${what} is not configured; see build-v1.md §4`);
    this.name = 'KaleidoNotConfiguredError';
  }
}

interface RestErrorBody {
  readonly error?: string;
}

/** FireFly's `core.Operation`. Only the fields this client reads. */
interface FireflyOperation {
  readonly id: string;
  readonly tx?: string;
  readonly status: 'Initialized' | 'Pending' | 'Succeeded' | 'Failed';
  readonly output?: Record<string, unknown>;
  readonly error?: string;
}

/** FireFly's `core.Transaction`. Only the fields this client reads. */
interface FireflyTransaction {
  readonly blockchainIds?: readonly string[];
}

export class KaleidoRestClient implements KaleidoClient {
  private readonly fetchImpl: typeof fetch;
  private readonly namespace: string;
  private readonly contractApiName: string;
  private readonly authHeader: string;

  constructor(private readonly config: KaleidoRestClientConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.namespace = config.namespace ?? 'default';
    this.contractApiName = config.contractApiName ?? 'evidenceanchor';

    const scheme = config.authScheme ?? 'basic';
    this.authHeader =
      scheme === 'basic'
        ? `Basic ${Buffer.from(`${config.apiKey}:`).toString('base64')}`
        : `Bearer ${config.apiKey}`;
  }

  // --- KaleidoClient ------------------------------------------------------

  /**
   * Verify: POST .../apis/{apiName}/invoke/{methodPath}, request/response
   * shapes from `route_post_contract_api_invoke.go` and
   * `pkg/core/contracts.go` (`ContractCallRequest`) in hyperledger-firefly/firefly.
   * Parameter names (`merkleRoot`, `subjectType`, `subjectRef`, `periodEnd`)
   * come straight from `contracts/EvidenceAnchor.sol`'s `anchor()` signature —
   * FireFly's registered-API invoke matches `input` keys to the ABI by name.
   */
  async submitAnchor(request: AnchorRequest): Promise<AnchorSubmission> {
    const input = {
      merkleRoot: `0x${request.merkleRoot}`,
      subjectType: ANCHOR_SUBJECT_ORDINAL[request.subjectType],
      subjectRef: uuidToBytes32(request.subjectId),
      periodEnd: request.periodEnd,
    };

    let op: FireflyOperation;
    try {
      op = await this.request<FireflyOperation>(
        'POST',
        `/api/v1/namespaces/${this.namespace}/apis/${this.contractApiName}/invoke/anchor?confirm=false`,
        { key: this.config.signingKey, input },
      );
    } catch (error) {
      throw this.translateAnchorError(error);
    }

    return { operationId: op.id };
  }

  /**
   * Verify: GET .../operations/{opid} -> `OperationWithDetail`
   * (`route_get_op_by_id.go`); status enum from `pkg/core/operation.go`
   * (`OpStatusInitialized|Pending|Succeeded|Failed` — no separate "Confirmed").
   * The transaction hash is not a first-class `Operation` field: it lands on
   * the FireFly `Transaction` record (`internal/txcommon.PersistTransaction`),
   * so a confirmed operation needs a second lookup by `op.tx`. `output` is
   * checked first as a fast path, since some connector receipts do echo the
   * hash there — but that is a connector-specific convenience, not something
   * confirmed in FireFly core, so it is a fallback rather than the only path.
   */
  async getAnchorReceipt(operationId: string): Promise<AnchorReceipt> {
    const op = await this.request<FireflyOperation>(
      'GET',
      `/api/v1/namespaces/${this.namespace}/operations/${operationId}`,
    );

    if (op.status === 'Initialized' || op.status === 'Pending') {
      return { operationId, status: 'PENDING' };
    }
    if (op.status === 'Failed') {
      return { operationId, status: 'FAILED', ...(op.error === undefined ? {} : { error: op.error }) };
    }

    // Succeeded.
    const fastPathHash = this.extractHashFromOutput(op.output);
    const transactionHash = fastPathHash ?? (await this.lookupTransactionHash(op.tx));

    return {
      operationId,
      status: 'CONFIRMED',
      ...(transactionHash === undefined ? {} : { transactionHash }),
    };
  }

  /**
   * Verify: POST .../contracts/query -> `map[string]interface{}`
   * (`route_post_contract_query.go`). `location`/`method` shapes match
   * evmconnect's ABI-call convention (`internal/ethereum/exec_query.go`
   * decodes against `method.Outputs`); a single unnamed `uint256` return is
   * evmconnect's own naming choice for the output key, not confirmed in
   * FireFly core — `output` is tried first, then the query's first value, as
   * a deliberately visible fallback rather than a silent one.
   *
   * Block context does NOT come from this call — see the file header.
   */
  async getTokenSupply(query: TokenSupplyQuery): Promise<TokenSupplyResult> {
    // Checked first, before any network call: failing fast on missing config
    // is cheap, and it means an unconfigured deployment doesn't spend a
    // request on a read it cannot use, the same way evaluatePolicy does.
    if (this.config.resolveBlockContext === undefined) {
      throw new KaleidoNotConfiguredError('resolveBlockContext (block number/timestamp for a supply read)');
    }

    const namespace = (this.config.resolveConnectorNamespace ?? ((id) => id))(query.connectorId);

    const result = await this.request<Record<string, unknown>>(
      'POST',
      `/api/v1/namespaces/${namespace}/contracts/query`,
      {
        location: { address: query.contractAddress },
        method: {
          name: 'totalSupply',
          params: [],
          returns: [{ name: 'output', type: 'uint256' }],
        },
        input: {},
      },
    );

    const raw = 'output' in result ? result['output'] : Object.values(result)[0];
    if (raw === undefined) {
      throw new Error(`totalSupply query for ${query.contractAddress} returned no value`);
    }
    const totalSupply = BigInt(String(raw));

    const { blockNumber, blockTimestamp } = await this.config.resolveBlockContext(query.connectorId);
    return { totalSupply, blockNumber, blockTimestamp };
  }

  /**
   * Verify: OPA data-plane convention (`POST {policyManagerUrl}/v1/data/<path>`
   * -> `{"result": ...}`), grounded in plan.md's "OPA-based policy engine"
   * description of PMS, not in a Kaleido-specific route. `certification.ts`
   * only calls this after its own four-eyes, step-up and critical-breach
   * checks pass, and only trusts `.allowed` to admit the signature — so if
   * PMS actually exposes a different convenience route, the failure mode is a
   * loud one (every approval refused), not a silent policy bypass.
   */
  async evaluatePolicy(request: PolicyRequest): Promise<PolicyEvaluation> {
    if (this.config.policyManagerUrl === undefined) {
      throw new KaleidoNotConfiguredError('KALEIDO_POLICY_MANAGER_URL');
    }

    const path = request.policy.replace(/\./g, '/');
    const response = await this.rawRequest(
      'POST',
      `${this.config.policyManagerUrl.replace(/\/+$/, '')}/v1/data/${path}`,
      { input: request.input },
    );

    const body = (await response.json()) as {
      readonly result?: { readonly allow?: boolean; readonly reason?: string; readonly decision_id?: string };
    };
    const decisionIdHeader = response.headers.get('Decision-ID') ?? undefined;

    return {
      allowed: body.result?.allow === true,
      decisionId: body.result?.decision_id ?? decisionIdHeader ?? `opa-${Date.now()}`,
      ...(body.result?.reason === undefined ? {} : { reason: body.result.reason }),
    };
  }

  /** Verify: no grounded shape exists for this — see the file header. */
  async getLatestTetherProof(): Promise<string | null> {
    if (this.config.tetherUrl === undefined) return null;

    const response = await this.rawRequest('GET', this.config.tetherUrl, undefined);
    const body = (await response.json()) as { readonly proof?: string };
    return body.proof ?? null;
  }

  // --- internals ------------------------------------------------------------

  private extractHashFromOutput(output: Record<string, unknown> | undefined): string | undefined {
    if (output === undefined) return undefined;
    const candidate = output['transactionHash'];
    return typeof candidate === 'string' ? candidate : undefined;
  }

  private async lookupTransactionHash(txId: string | undefined): Promise<string | undefined> {
    if (txId === undefined) return undefined;
    const tx = await this.request<FireflyTransaction>(
      'GET',
      `/api/v1/namespaces/${this.namespace}/transactions/${txId}`,
    );
    return tx.blockchainIds?.[0];
  }

  /**
   * `EvidenceService.anchor` (evidence.ts) recognises a retryable duplicate by
   * checking `error.message.startsWith('AlreadyAnchored')` — matching
   * `FakeKaleidoClient`'s convention exactly, so the real client must produce
   * the identical string shape rather than merely a similar one.
   */
  private translateAnchorError(error: unknown): Error {
    const message = error instanceof KaleidoHttpError ? this.parseRestError(error.body) : String(error);

    if (message !== undefined && /AlreadyAnchored/i.test(message)) {
      const subjectKeyMatch = /AlreadyAnchored\(?([0-9a-fx]*)\)?/i.exec(message);
      return new Error(`AlreadyAnchored: ${subjectKeyMatch?.[1] ?? message}`);
    }
    if (message !== undefined && /ZeroRoot/i.test(message)) {
      return new Error('ZeroRoot');
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private parseRestError(body: string): string | undefined {
    try {
      return (JSON.parse(body) as RestErrorBody).error ?? body;
    } catch {
      return body;
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.rawRequest(method, `${this.config.apiUrl.replace(/\/+$/, '')}${path}`, body);
    return (await response.json()) as T;
  }

  private async rawRequest(method: string, url: string, body: unknown): Promise<Response> {
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new KaleidoHttpError(method, url, response.status, text);
    }
    return response;
  }
}

/**
 * Build a `KaleidoRestClient` from `.env.example`'s Kaleido variables, or
 * return `null` when `KALEIDO_API_URL` is unset — the signal `main.ts` uses to
 * fall back to `FakeKaleidoClient`, matching the README's stated status
 * ("Interface + fake only — real implementation blocked on credentials").
 *
 * `resolveBlockContext` is not wired from the environment: no env var
 * describes it because no verified shape exists yet (see the file header). A
 * deployment that has resolved it — even provisionally, against a raw RPC
 * endpoint rather than anything Kaleido-specific — passes it as `overrides`.
 */
export function kaleidoClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Pick<KaleidoRestClientConfig, 'resolveBlockContext'> = {},
): KaleidoRestClient | null {
  const apiUrl = env['KALEIDO_API_URL'];
  if (apiUrl === undefined || apiUrl.trim() === '') return null;

  const apiKey = requireEnv(env, 'KALEIDO_API_KEY');
  const signingKey = requireEnv(env, 'KALEIDO_KMS_KEY_ID');

  const authScheme = env['KALEIDO_AUTH_SCHEME'];
  if (authScheme !== undefined && authScheme !== 'basic' && authScheme !== 'bearer') {
    throw new Error(`KALEIDO_AUTH_SCHEME must be "basic" or "bearer", got ${JSON.stringify(authScheme)}`);
  }

  const policyManagerUrl = env['KALEIDO_POLICY_MANAGER_URL'];
  const tetherUrl = env['KALEIDO_TETHER_URL'];
  const namespace = env['KALEIDO_NAMESPACE'];
  const contractApiName = env['KALEIDO_CONTRACT_API_NAME'];

  return new KaleidoRestClient({
    apiUrl,
    apiKey,
    signingKey,
    ...(authScheme === undefined ? {} : { authScheme }),
    ...(namespace === undefined || namespace === '' ? {} : { namespace }),
    ...(contractApiName === undefined || contractApiName === '' ? {} : { contractApiName }),
    ...(policyManagerUrl === undefined || policyManagerUrl === '' ? {} : { policyManagerUrl }),
    ...(tetherUrl === undefined || tetherUrl === '' ? {} : { tetherUrl }),
    ...overrides,
  });
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set (KALEIDO_API_URL is set, so a real client was requested)`);
  }
  return value;
}
