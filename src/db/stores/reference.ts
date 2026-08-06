import type { TokenDeployment } from '../../domain/types.js';
import type { Queryable } from '../pool.js';
import type { CustodianConnector, CustodianRow, TokenDeploymentRow } from '../rows.js';
import {
  CUSTODIAN_COLUMNS,
  TOKEN_DEPLOYMENT_COLUMNS,
  toCustodianConnector,
  toTokenDeployment,
} from '../rows.js';

/**
 * Reference-data stores: issuers, custodians and token deployments.
 *
 * These are the small, mutable configuration tables. Everything else in the
 * system joins against them, so every list is returned in a deterministic order
 * — a report that renders custodians in whatever order Postgres happened to
 * scan them would produce a different payload hash on every regeneration.
 */

export interface IssuerRecord {
  readonly id: string;
  readonly legalName: string;
  readonly regulator: string;
  readonly kaleidoEnvId: string;
  readonly anchorContractAddress: string | null;
  readonly businessCalendar: string;
  readonly ruleConfig: Record<string, unknown>;
}

interface IssuerRow {
  id: string;
  legal_name: string;
  regulator: string;
  kaleido_env_id: string;
  anchor_contract_address: string | null;
  business_calendar: string;
  rule_config: unknown;
}

const ISSUER_COLUMNS =
  'id, legal_name, regulator, kaleido_env_id, anchor_contract_address, ' +
  'business_calendar, rule_config';

function toIssuerRecord(row: IssuerRow): IssuerRecord {
  return {
    id: row.id,
    legalName: row.legal_name,
    regulator: row.regulator,
    kaleidoEnvId: row.kaleido_env_id,
    anchorContractAddress: row.anchor_contract_address,
    businessCalendar: row.business_calendar,
    ruleConfig: requireJsonObject(row.rule_config, 'rule_config'),
  };
}

/**
 * JSONB can legitimately hold `null`, an array or a scalar. `rule_config` carries
 * the issuer's eligibility thresholds, so defaulting a malformed value to `{}`
 * would quietly run certification against the built-in limits instead of the
 * issuer's own — a wrong answer that looks entirely healthy.
 */
function requireJsonObject(value: unknown, column: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`column ${column} is not a JSON object: ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

export class PgIssuerStore {
  constructor(private readonly db: Queryable) {}

  async get(id: string): Promise<IssuerRecord | null> {
    const result = await this.db.query(`SELECT ${ISSUER_COLUMNS} FROM issuers WHERE id = $1`, [id]);
    const row = (result.rows as IssuerRow[])[0];
    return row === undefined ? null : toIssuerRecord(row);
  }

  async listAll(): Promise<IssuerRecord[]> {
    const result = await this.db.query(`SELECT ${ISSUER_COLUMNS} FROM issuers ORDER BY id`);
    return (result.rows as IssuerRow[]).map(toIssuerRecord);
  }
}

export class PgCustodianStore {
  constructor(private readonly db: Queryable) {}

  async listForIssuer(issuerId: string): Promise<CustodianConnector[]> {
    return this.list(issuerId, false);
  }

  async listActiveForIssuer(issuerId: string): Promise<CustodianConnector[]> {
    return this.list(issuerId, true);
  }

  async get(id: string): Promise<CustodianConnector | null> {
    const result = await this.db.query(
      `SELECT ${CUSTODIAN_COLUMNS} FROM custodians WHERE id = $1`,
      [id],
    );
    const row = (result.rows as CustodianRow[])[0];
    return row === undefined ? null : toCustodianConnector(row);
  }

  private async list(issuerId: string, activeOnly: boolean): Promise<CustodianConnector[]> {
    const result = await this.db.query(
      `SELECT ${CUSTODIAN_COLUMNS} FROM custodians
       WHERE issuer_id = $1 ${activeOnly ? 'AND active' : ''}
       ORDER BY id`,
      [issuerId],
    );
    return (result.rows as CustodianRow[]).map(toCustodianConnector);
  }
}

export class PgTokenDeploymentStore {
  constructor(private readonly db: Queryable) {}

  async listForIssuer(issuerId: string): Promise<TokenDeployment[]> {
    return this.list(issuerId, false);
  }

  async listActiveForIssuer(issuerId: string): Promise<TokenDeployment[]> {
    return this.list(issuerId, true);
  }

  async get(id: string): Promise<TokenDeployment | null> {
    const result = await this.db.query(
      `SELECT ${TOKEN_DEPLOYMENT_COLUMNS} FROM token_deployments WHERE id = $1`,
      [id],
    );
    const row = (result.rows as TokenDeploymentRow[])[0];
    return row === undefined ? null : toTokenDeployment(row);
  }

  private async list(issuerId: string, activeOnly: boolean): Promise<TokenDeployment[]> {
    const result = await this.db.query(
      `SELECT ${TOKEN_DEPLOYMENT_COLUMNS} FROM token_deployments
       WHERE issuer_id = $1 ${activeOnly ? 'AND active' : ''}
       ORDER BY chain_id, contract_address`,
      [issuerId],
    );
    return (result.rows as TokenDeploymentRow[]).map(toTokenDeployment);
  }
}
