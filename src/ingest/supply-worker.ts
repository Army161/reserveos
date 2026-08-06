import type pg from 'pg';
import { withTenant } from '../db/pool.js';
import type { KaleidoClient } from '../kaleido/client.js';
import type { TokenDeployment } from '../domain/types.js';
import {
  ConflictingSupplyObservationError,
  PgSupplyFactStore,
} from '../db/stores/facts.js';
import { PgTokenDeploymentStore } from '../db/stores/reference.js';

/**
 * Token supply observation worker.
 *
 * Reads `totalSupply()` for every active deployment and records it. Outstanding
 * supply is the denominator of the collateralization ratio, so a deployment this
 * worker fails to observe does not quietly vanish — `computePeriod` raises a
 * CRITICAL `NO_SUPPLY_OBSERVATION` breach for any active deployment with no
 * observation at period end, which blocks certification. This worker's job is to
 * make that never happen, and to be loud when it does.
 */

export type SupplyPollStatus = 'RECORDED' | 'UNCHANGED' | 'FAILED' | 'CONFLICT';

export interface SupplyPollOutcome {
  readonly deploymentId: string;
  readonly chainId: number;
  readonly contractAddress: string;
  readonly status: SupplyPollStatus;
  readonly totalSupply: bigint | null;
  readonly blockNumber: bigint | null;
  readonly error: string | null;
}

export interface SupplyWorkerOptions {
  readonly pool: pg.Pool;
  readonly kaleido: KaleidoClient;
  readonly now: () => Date;
  /** Connector id per deployment id; from `token_deployments.kaleido_connector_id`. */
  readonly connectorIdFor: (deployment: TokenDeployment) => string;
}

export class SupplyObservationWorker {
  constructor(private readonly options: SupplyWorkerOptions) {}

  /** Poll every active deployment for an issuer. */
  async run(issuerId: string): Promise<SupplyPollOutcome[]> {
    const deployments = await withTenant(this.options.pool, issuerId, (client) =>
      new PgTokenDeploymentStore(client).listActiveForIssuer(issuerId),
    );

    const outcomes: SupplyPollOutcome[] = [];
    for (const deployment of deployments) {
      outcomes.push(await this.poll(deployment));
    }
    return outcomes;
  }

  async poll(deployment: TokenDeployment): Promise<SupplyPollOutcome> {
    const base = {
      deploymentId: deployment.id,
      chainId: deployment.chainId,
      contractAddress: deployment.contractAddress,
    };

    let reading;
    try {
      reading = await this.options.kaleido.getTokenSupply({
        connectorId: this.options.connectorIdFor(deployment),
        contractAddress: deployment.contractAddress,
      });
    } catch (error) {
      // One unreachable chain must not stop the others: a partial sweep still
      // narrows the gap, and the missing deployment surfaces at period end.
      return {
        ...base,
        status: 'FAILED',
        totalSupply: null,
        blockNumber: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      // Scoped, and started only after the chain read returns: holding a
      // transaction open across a network call to an RPC endpoint would pin a
      // connection for as long as the slowest chain takes to answer.
      const recorded = await withTenant(this.options.pool, deployment.issuerId, (client) =>
        new PgSupplyFactStore(client).insert({
          tokenDeploymentId: deployment.id,
          blockNumber: reading.blockNumber,
          blockTimestamp: reading.blockTimestamp,
          totalSupply: reading.totalSupply,
          observedAt: this.options.now(),
        }),
      );

      return {
        ...base,
        // Null means this block was already observed with the same supply, which
        // is the normal case when polling faster than the chain produces blocks.
        status: recorded === null ? 'UNCHANGED' : 'RECORDED',
        totalSupply: reading.totalSupply,
        blockNumber: reading.blockNumber,
        error: null,
      };
    } catch (error) {
      if (error instanceof ConflictingSupplyObservationError) {
        // A reorg replaced history, or the indexer is wrong. Needs an operator,
        // not a retry: both figures cannot be true and the choice moves the
        // collateralization ratio.
        return {
          ...base,
          status: 'CONFLICT',
          totalSupply: reading.totalSupply,
          blockNumber: reading.blockNumber,
          error: error.message,
        };
      }
      throw error;
    }
  }
}

/** Deployments with no observation at or before `asOf` — the certification blockers. */
export async function findUnobservedDeployments(
  pool: pg.Pool,
  issuerId: string,
  asOf: Date,
): Promise<TokenDeployment[]> {
  const deployments = await new PgTokenDeploymentStore(pool).listActiveForIssuer(issuerId);
  const observed = await new PgSupplyFactStore(pool).listForIssuerAsOf(issuerId, asOf);
  const seen = new Set(observed.map((fact) => fact.tokenDeploymentId));
  return deployments.filter((deployment) => !seen.has(deployment.id));
}
