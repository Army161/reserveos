import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KaleidoHttpError,
  KaleidoNotConfiguredError,
  KaleidoRestClient,
  kaleidoClientFromEnv,
  type KaleidoRestClientConfig,
} from '../../src/kaleido/rest.js';
import { uuidToBytes32 } from '../../src/kaleido/client.js';

/**
 * Exercised against a real local HTTP server rather than a mocked `fetch`, so
 * these tests prove what they claim to: that `KaleidoRestClient` sends the
 * request shapes documented in its file header and parses the responses
 * correctly. They do not and cannot prove those shapes are what a live
 * Kaleido environment actually expects — see rest.ts's header for exactly
 * which parts are grounded in verified source versus flagged for the
 * provisioning spike.
 */

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | undefined>;
  readonly body: unknown;
}

interface Route {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

class MockServer {
  readonly requests: RecordedRequest[] = [];
  private routes = new Map<string, Route>();
  private server: Server | null = null;
  baseUrl = '';

  private key(method: string, path: string): string {
    return `${method} ${path}`;
  }

  on(method: string, path: string, route: Route): void {
    this.routes.set(this.key(method, path), route);
  }

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const [path] = (req.url ?? '').split('?');
        this.requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: { authorization: req.headers.authorization, 'content-type': req.headers['content-type'] },
          body: raw === '' ? undefined : JSON.parse(raw),
        });

        const route = this.routes.get(this.key(req.method ?? '', path ?? ''));
        if (route === undefined) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `no route stubbed for ${req.method} ${path}` }));
          return;
        }
        res.writeHead(route.status, { 'Content-Type': 'application/json', ...route.headers });
        res.end(JSON.stringify(route.body));
      });
    });

    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const address = this.server?.address();
    if (address === null || address === undefined || typeof address === 'string') {
      throw new Error('mock server did not bind to a port');
    }
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server?.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

const SUBJECT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

let mock: MockServer;

beforeEach(async () => {
  mock = new MockServer();
  await mock.start();
});

afterEach(async () => {
  await mock.stop();
});

function client(overrides: Partial<KaleidoRestClientConfig> = {}): KaleidoRestClient {
  return new KaleidoRestClient({
    apiUrl: mock.baseUrl,
    apiKey: 'test-api-key',
    signingKey: '0xsigner',
    ...overrides,
  });
}

describe('KaleidoRestClient.submitAnchor', () => {
  it('POSTs the exact FireFly contract-API-invoke shape, with confirm=false', async () => {
    mock.on('POST', '/api/v1/namespaces/default/apis/evidenceanchor/invoke/anchor', {
      status: 202,
      body: { id: 'op-123', namespace: 'default', status: 'Pending' },
    });

    const result = await client().submitAnchor({
      merkleRoot: 'a'.repeat(64),
      subjectType: 'REPORT_VERSION',
      subjectId: SUBJECT_ID,
      periodEnd: 20_150,
    });

    expect(result.operationId).toBe('op-123');
    expect(mock.requests).toHaveLength(1);
    const req = mock.requests[0]!;
    expect(req.url).toBe('/api/v1/namespaces/default/apis/evidenceanchor/invoke/anchor?confirm=false');
    expect(req.body).toEqual({
      key: '0xsigner',
      input: {
        merkleRoot: `0x${'a'.repeat(64)}`,
        subjectType: 1, // REPORT_VERSION ordinal, from ANCHOR_SUBJECT_ORDINAL
        subjectRef: uuidToBytes32(SUBJECT_ID),
        periodEnd: 20_150,
      },
    });
  });

  it('authenticates with HTTP Basic by default, the key as username', async () => {
    mock.on('POST', '/api/v1/namespaces/default/apis/evidenceanchor/invoke/anchor', {
      status: 202,
      body: { id: 'op-1', status: 'Pending' },
    });

    await client().submitAnchor({
      merkleRoot: 'b'.repeat(64),
      subjectType: 'DAILY_ROLLUP',
      subjectId: SUBJECT_ID,
      periodEnd: 0,
    });

    const expected = `Basic ${Buffer.from('test-api-key:').toString('base64')}`;
    expect(mock.requests[0]!.headers['authorization']).toBe(expected);
  });

  it('uses a bearer token when configured for it', async () => {
    mock.on('POST', '/api/v1/namespaces/default/apis/evidenceanchor/invoke/anchor', {
      status: 202,
      body: { id: 'op-1', status: 'Pending' },
    });

    await client({ authScheme: 'bearer' }).submitAnchor({
      merkleRoot: 'c'.repeat(64),
      subjectType: 'APPROVAL',
      subjectId: SUBJECT_ID,
      periodEnd: 0,
    });

    expect(mock.requests[0]!.headers['authorization']).toBe('Bearer test-api-key');
  });

  it('respects a configured namespace and contract API name', async () => {
    mock.on('POST', '/api/v1/namespaces/issuer-ns/apis/reserveos-anchor/invoke/anchor', {
      status: 202,
      body: { id: 'op-9', status: 'Pending' },
    });

    await client({ namespace: 'issuer-ns', contractApiName: 'reserveos-anchor' }).submitAnchor({
      merkleRoot: 'd'.repeat(64),
      subjectType: 'REPORT_VERSION',
      subjectId: SUBJECT_ID,
      periodEnd: 1,
    });

    expect(mock.requests).toHaveLength(1);
  });

  it('translates a contract-reverted AlreadyAnchored into the string EvidenceService matches on', async () => {
    // Shape modeled on FireFly's RESTError envelope ({"error": string}) wrapping
    // an evmconnect revert reason; the exact wording of the revert message
    // itself is not confirmed against a live connector, only the envelope.
    mock.on('POST', '/api/v1/namespaces/default/apis/evidenceanchor/invoke/anchor', {
      status: 409,
      body: { error: 'FF10430: reverted: AlreadyAnchored(0xdeadbeef)' },
    });

    await expect(
      client().submitAnchor({
        merkleRoot: 'e'.repeat(64),
        subjectType: 'REPORT_VERSION',
        subjectId: SUBJECT_ID,
        periodEnd: 0,
      }),
    ).rejects.toThrow(/^AlreadyAnchored/);
  });

  it('translates a contract-reverted ZeroRoot into the exact string EvidenceService does not special-case, but fake.ts also throws verbatim', async () => {
    mock.on('POST', '/api/v1/namespaces/default/apis/evidenceanchor/invoke/anchor', {
      status: 400,
      body: { error: 'reverted: ZeroRoot()' },
    });

    await expect(
      client().submitAnchor({
        merkleRoot: '0'.repeat(64),
        subjectType: 'REPORT_VERSION',
        subjectId: SUBJECT_ID,
        periodEnd: 0,
      }),
    ).rejects.toThrow('ZeroRoot');
  });

  it('surfaces an unrecognized failure as a KaleidoHttpError rather than swallowing it', async () => {
    mock.on('POST', '/api/v1/namespaces/default/apis/evidenceanchor/invoke/anchor', {
      status: 500,
      body: { error: 'internal server error' },
    });

    await expect(
      client().submitAnchor({
        merkleRoot: 'f'.repeat(64),
        subjectType: 'REPORT_VERSION',
        subjectId: SUBJECT_ID,
        periodEnd: 0,
      }),
    ).rejects.toThrow(/internal server error/);
  });
});

describe('KaleidoRestClient.getAnchorReceipt', () => {
  it('maps Initialized and Pending to PENDING', async () => {
    mock.on('GET', '/api/v1/namespaces/default/operations/op-1', {
      status: 200,
      body: { id: 'op-1', status: 'Initialized' },
    });
    expect((await client().getAnchorReceipt('op-1')).status).toBe('PENDING');
  });

  it('maps Failed to FAILED and carries the error message', async () => {
    mock.on('GET', '/api/v1/namespaces/default/operations/op-2', {
      status: 200,
      body: { id: 'op-2', status: 'Failed', error: 'connector unreachable' },
    });
    const receipt = await client().getAnchorReceipt('op-2');
    expect(receipt.status).toBe('FAILED');
    expect(receipt.error).toBe('connector unreachable');
  });

  it('takes the transaction hash from output as a fast path, without a second request', async () => {
    mock.on('GET', '/api/v1/namespaces/default/operations/op-3', {
      status: 200,
      body: { id: 'op-3', status: 'Succeeded', tx: 'tx-1', output: { transactionHash: '0xabc123' } },
    });
    const receipt = await client().getAnchorReceipt('op-3');
    expect(receipt.status).toBe('CONFIRMED');
    expect(receipt.transactionHash).toBe('0xabc123');
    expect(mock.requests).toHaveLength(1); // no fallback transaction lookup
  });

  it('falls back to the transaction record when output carries no hash', async () => {
    mock.on('GET', '/api/v1/namespaces/default/operations/op-4', {
      status: 200,
      body: { id: 'op-4', status: 'Succeeded', tx: 'tx-2' },
    });
    mock.on('GET', '/api/v1/namespaces/default/transactions/tx-2', {
      status: 200,
      body: { id: 'tx-2', blockchainIds: ['0xdeadbeef'] },
    });

    const receipt = await client().getAnchorReceipt('op-4');
    expect(receipt.status).toBe('CONFIRMED');
    expect(receipt.transactionHash).toBe('0xdeadbeef');
    expect(mock.requests).toHaveLength(2);
  });

  it('confirms without a hash rather than throwing, when neither source has one', async () => {
    mock.on('GET', '/api/v1/namespaces/default/operations/op-5', {
      status: 200,
      body: { id: 'op-5', status: 'Succeeded' },
    });
    const receipt = await client().getAnchorReceipt('op-5');
    expect(receipt.status).toBe('CONFIRMED');
    expect(receipt.transactionHash).toBeUndefined();
  });
});

describe('KaleidoRestClient.getTokenSupply', () => {
  it('rejects before any network call when resolveBlockContext is unconfigured', async () => {
    await expect(
      client().getTokenSupply({ connectorId: 'conn-1', contractAddress: '0xtoken' }),
    ).rejects.toThrow(KaleidoNotConfiguredError);
    expect(mock.requests).toHaveLength(0);
  });

  it('queries totalSupply via the ad-hoc contracts/query path and combines it with resolved block context', async () => {
    mock.on('POST', '/api/v1/namespaces/conn-1/contracts/query', {
      status: 200,
      body: { output: '7000000000000' },
    });

    const result = await client({
      resolveBlockContext: async () => ({
        blockNumber: 21_500_000n,
        blockTimestamp: new Date('2026-03-31T23:50:00.000Z'),
      }),
    }).getTokenSupply({ connectorId: 'conn-1', contractAddress: '0xtoken' });

    expect(result.totalSupply).toBe(7_000_000_000_000n);
    expect(result.blockNumber).toBe(21_500_000n);
    expect(result.blockTimestamp).toEqual(new Date('2026-03-31T23:50:00.000Z'));

    const req = mock.requests[0]!;
    expect(req.body).toEqual({
      location: { address: '0xtoken' },
      method: { name: 'totalSupply', params: [], returns: [{ name: 'output', type: 'uint256' }] },
      input: {},
    });
  });

  it('falls back to the first value when the response has no "output" key', async () => {
    mock.on('POST', '/api/v1/namespaces/conn-1/contracts/query', {
      status: 200,
      body: { totalSupply: '42' },
    });

    const result = await client({
      resolveBlockContext: async () => ({ blockNumber: 1n, blockTimestamp: new Date(0) }),
    }).getTokenSupply({ connectorId: 'conn-1', contractAddress: '0xtoken' });

    expect(result.totalSupply).toBe(42n);
  });

  it('resolves the namespace from connectorId through the configured mapping', async () => {
    mock.on('POST', '/api/v1/namespaces/mapped-ns/contracts/query', {
      status: 200,
      body: { output: '1' },
    });

    await client({
      resolveConnectorNamespace: (connectorId) => `mapped-${connectorId}`,
      resolveBlockContext: async () => ({ blockNumber: 1n, blockTimestamp: new Date(0) }),
    }).getTokenSupply({ connectorId: 'ns', contractAddress: '0xtoken' });

    expect(mock.requests).toHaveLength(1);
  });
});

describe('KaleidoRestClient.evaluatePolicy', () => {
  it('rejects before any network call when policyManagerUrl is unconfigured', async () => {
    await expect(
      client().evaluatePolicy({ policy: 'reserveos.certification', input: {} }),
    ).rejects.toThrow(KaleidoNotConfiguredError);
    expect(mock.requests).toHaveLength(0);
  });

  it('POSTs the OPA data-plane shape and reads allow/reason/decision_id from result', async () => {
    mock.on('POST', '/v1/data/reserveos/certification', {
      status: 200,
      body: { result: { allow: false, reason: 'role already signed', decision_id: 'opa-decision-1' } },
    });

    const evaluation = await client({ policyManagerUrl: mock.baseUrl }).evaluatePolicy({
      policy: 'reserveos.certification',
      input: { role: 'CFO' },
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reason).toBe('role already signed');
    expect(evaluation.decisionId).toBe('opa-decision-1');
    expect(mock.requests[0]!.body).toEqual({ input: { role: 'CFO' } });
  });

  it('falls back to the Decision-ID header when the body omits decision_id', async () => {
    mock.on('POST', '/v1/data/reserveos/certification', {
      status: 200,
      body: { result: { allow: true } },
      headers: { 'Decision-ID': 'header-decision-1' },
    });

    const evaluation = await client({ policyManagerUrl: mock.baseUrl }).evaluatePolicy({
      policy: 'reserveos.certification',
      input: {},
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.decisionId).toBe('header-decision-1');
  });

  it('treats a missing allow field as not allowed, never defaulting open', async () => {
    mock.on('POST', '/v1/data/reserveos/certification', {
      status: 200,
      body: { result: {} },
    });

    const evaluation = await client({ policyManagerUrl: mock.baseUrl }).evaluatePolicy({
      policy: 'reserveos.certification',
      input: {},
    });

    expect(evaluation.allowed).toBe(false);
  });
});

describe('KaleidoRestClient.getLatestTetherProof', () => {
  it('returns null without a network call when tetherUrl is unconfigured', async () => {
    expect(await client().getLatestTetherProof()).toBeNull();
    expect(mock.requests).toHaveLength(0);
  });

  it('reads the proof field when configured', async () => {
    mock.on('GET', '/proof', { status: 200, body: { proof: 'tether-proof-abc' } });
    const result = await client({ tetherUrl: `${mock.baseUrl}/proof` }).getLatestTetherProof();
    expect(result).toBe('tether-proof-abc');
  });
});

describe('kaleidoClientFromEnv', () => {
  it('returns null when KALEIDO_API_URL is unset', () => {
    expect(kaleidoClientFromEnv({})).toBeNull();
  });

  it('returns null when KALEIDO_API_URL is set but blank', () => {
    expect(kaleidoClientFromEnv({ KALEIDO_API_URL: '  ' })).toBeNull();
  });

  it('throws naming the missing variable when the API URL is set but the API key is not', () => {
    expect(() => kaleidoClientFromEnv({ KALEIDO_API_URL: 'https://x' })).toThrow(/KALEIDO_API_KEY/);
  });

  it('throws naming the missing variable when the signing key is not set', () => {
    expect(() =>
      kaleidoClientFromEnv({ KALEIDO_API_URL: 'https://x', KALEIDO_API_KEY: 'k' }),
    ).toThrow(/KALEIDO_KMS_KEY_ID/);
  });

  it('rejects an auth scheme it does not recognize', () => {
    expect(() =>
      kaleidoClientFromEnv({
        KALEIDO_API_URL: 'https://x',
        KALEIDO_API_KEY: 'k',
        KALEIDO_KMS_KEY_ID: 'key-1',
        KALEIDO_AUTH_SCHEME: 'digest',
      }),
    ).toThrow(/KALEIDO_AUTH_SCHEME/);
  });

  it('builds a working client from a full environment', async () => {
    mock.on('POST', '/api/v1/namespaces/default/apis/evidenceanchor/invoke/anchor', {
      status: 202,
      body: { id: 'op-env', status: 'Pending' },
    });

    const instance = kaleidoClientFromEnv({
      KALEIDO_API_URL: mock.baseUrl,
      KALEIDO_API_KEY: 'env-key',
      KALEIDO_KMS_KEY_ID: 'env-signer',
    });
    expect(instance).not.toBeNull();

    const result = await instance!.submitAnchor({
      merkleRoot: '1'.repeat(64),
      subjectType: 'REPORT_VERSION',
      subjectId: SUBJECT_ID,
      periodEnd: 0,
    });
    expect(result.operationId).toBe('op-env');
  });
});

describe('KaleidoHttpError', () => {
  it('names the method, path and status so a failure is diagnosable from the message alone', () => {
    const error = new KaleidoHttpError('POST', '/api/v1/namespaces/default/foo', 503, '{"error":"down"}');
    expect(error.message).toContain('POST');
    expect(error.message).toContain('/api/v1/namespaces/default/foo');
    expect(error.message).toContain('503');
  });
});
