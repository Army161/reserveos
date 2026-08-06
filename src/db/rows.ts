import type {
  Custodian,
  InstrumentCategory,
  ReserveFact,
  SupplyFact,
  TokenDeployment,
} from '../domain/types.js';
import { toBigInt } from './types.js';

/**
 * Row → domain mappers.
 *
 * Every mapper is total and strict: a column that is not the shape we expect
 * throws rather than coercing. A silently-coerced reserve value is a wrong
 * number on a certified report, which is the failure mode this whole system
 * exists to prevent.
 */

/** Shape of a `reserve_facts` row as the driver returns it. */
export interface ReserveFactRow {
  id: string;
  issuer_id: string;
  custodian_id: string;
  as_of: Date;
  observed_at: Date;
  instrument_category: InstrumentCategory;
  cusip: string | null;
  currency: string;
  face_value_minor: string;
  market_value_minor: string;
  maturity_date: Date | null;
  source_hash: string;
  superseded_by: string | null;
}

export const RESERVE_FACT_COLUMNS =
  'id, issuer_id, custodian_id, as_of, observed_at, instrument_category, cusip, ' +
  'currency, face_value_minor, market_value_minor, maturity_date, source_hash, superseded_by';

export function toReserveFact(row: ReserveFactRow): ReserveFact {
  return {
    id: row.id,
    issuerId: row.issuer_id,
    custodianId: row.custodian_id,
    asOf: requireDate(row.as_of, 'as_of'),
    observedAt: requireDate(row.observed_at, 'observed_at'),
    instrumentCategory: row.instrument_category,
    cusip: row.cusip,
    currency: row.currency,
    faceValueMinor: toBigInt(row.face_value_minor),
    marketValueMinor: toBigInt(row.market_value_minor),
    maturityDate: row.maturity_date === null ? null : requireDate(row.maturity_date, 'maturity_date'),
    sourceHash: row.source_hash,
    supersededBy: row.superseded_by,
  };
}

export interface SupplyFactRow {
  id: string;
  token_deployment_id: string;
  block_number: string;
  block_timestamp: Date;
  total_supply: string;
  observed_at: Date;
}

export const SUPPLY_FACT_COLUMNS =
  'id, token_deployment_id, block_number, block_timestamp, total_supply, observed_at';

export function toSupplyFact(row: SupplyFactRow): SupplyFact {
  return {
    id: row.id,
    tokenDeploymentId: row.token_deployment_id,
    blockNumber: toBigInt(row.block_number),
    blockTimestamp: requireDate(row.block_timestamp, 'block_timestamp'),
    totalSupply: toBigInt(row.total_supply),
    observedAt: requireDate(row.observed_at, 'observed_at'),
  };
}

export interface TokenDeploymentRow {
  id: string;
  issuer_id: string;
  chain_id: number;
  contract_address: string;
  symbol: string;
  decimals: number;
  kaleido_connector_id: string;
  active: boolean;
}

export const TOKEN_DEPLOYMENT_COLUMNS =
  'id, issuer_id, chain_id, contract_address, symbol, decimals, kaleido_connector_id, active';

export function toTokenDeployment(row: TokenDeploymentRow): TokenDeployment {
  return {
    id: row.id,
    issuerId: row.issuer_id,
    chainId: row.chain_id,
    contractAddress: row.contract_address,
    symbol: row.symbol,
    decimals: row.decimals,
    active: row.active,
  };
}

export interface CustodianRow {
  id: string;
  issuer_id: string;
  name: string;
  jurisdiction: string;
  connector_type: 'sftp_csv' | 'api_rest' | 'manual';
  connector_config: Record<string, unknown>;
  active: boolean;
}

export const CUSTODIAN_COLUMNS =
  'id, issuer_id, name, jurisdiction, connector_type, connector_config, active';

export function toCustodian(row: CustodianRow): Custodian {
  return {
    id: row.id,
    issuerId: row.issuer_id,
    name: row.name,
    jurisdiction: row.jurisdiction,
  };
}

/** Custodian plus the ingestion wiring the domain type deliberately omits. */
export interface CustodianConnector extends Custodian {
  readonly connectorType: 'sftp_csv' | 'api_rest' | 'manual';
  readonly connectorConfig: Record<string, unknown>;
  readonly active: boolean;
}

export function toCustodianConnector(row: CustodianRow): CustodianConnector {
  return {
    ...toCustodian(row),
    connectorType: row.connector_type,
    connectorConfig: requireJsonObject(row.connector_config, 'connector_config'),
    active: row.active,
  };
}

/**
 * A JSONB column that must hold an object.
 *
 * `connector_config` is `NOT NULL DEFAULT '{}'`, but JSON `null` is a legal
 * value for a NOT NULL jsonb column and is not the same as SQL NULL. Coercing it
 * to `{}` would present a custodian with corrupt configuration as one with
 * default configuration, and ingestion would then silently read no column
 * mapping at all.
 */
function requireJsonObject(value: unknown, column: string): Record<string, unknown> {
  if (value === null || value === undefined) {
    throw new TypeError(`column ${column} is null; expected a JSON object`);
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`column ${column} is not a JSON object: ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function requireDate(value: unknown, column: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`column ${column} is not a valid timestamp: ${String(value)}`);
  }
  return value;
}
