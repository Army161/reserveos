import { beforeEach, describe, expect, it } from 'vitest';
import { databaseAvailable, resetDatabase, seedTenant, testPool, SEED_IDS } from './harness.js';
import { InMemoryStatementSource } from '../../src/ingest/source.js';
import {
  StatementIngestionWorker,
  lineHash,
  type CustodianFeed,
} from '../../src/ingest/statement-worker.js';
import { SupplyObservationWorker, findUnobservedDeployments } from '../../src/ingest/supply-worker.js';
import { PgReserveFactStore, PgSupplyFactStore } from '../../src/db/stores/facts.js';
import { PgSourceDocumentStore } from '../../src/db/stores/documents.js';
import { FakeKaleidoClient } from '../../src/kaleido/fake.js';
import type { StatementMapping } from '../../src/ingest/mapping.js';
import type { TokenDeployment } from '../../src/domain/types.js';

const available = await databaseAvailable();

const NOW = new Date('2026-04-01T09:00:00.000Z');

const MAPPING: StatementMapping = {
  columns: {
    category: 'Asset Type',
    marketValue: 'Market Value',
    faceValue: 'Par Value',
    cusip: 'CUSIP',
    maturityDate: 'Maturity',
  },
  dateFormat: 'ISO',
  defaultCurrency: 'USD',
};

const STATEMENT = [
  'Asset Type,CUSIP,Par Value,Market Value,Maturity,Statement Date',
  '"US Treasury Bill",912797KL0,"5,000,000.00","4,992,150.00",2026-05-15,2026-03-31',
  '"Treasury Bill",912797MM6,"3,500,000.00","3,488,220.00",2026-06-20,2026-03-31',
  '"Demand Deposit",,"2,000,000.00","2,000,000.00",,2026-03-31',
  '',
].join('\n');

function feed(source: InMemoryStatementSource): CustodianFeed {
  return {
    issuerId: SEED_IDS.issuerId,
    custodianId: SEED_IDS.bny,
    source,
    mapping: MAPPING,
    statementDate: { kind: 'column', column: 'Statement Date' },
  };
}

describe.skipIf(!available)('statement ingestion worker', () => {
  let worker: StatementIngestionWorker;
  let source: InMemoryStatementSource;

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
    source = new InMemoryStatementSource('bny-sftp');
    worker = new StatementIngestionWorker({ pool: testPool(), now: () => NOW });
  });

  it('ingests a statement end to end with exact amounts', async () => {
    source.add('bny-2026-03-31.csv', STATEMENT);

    const [outcome] = await worker.run(feed(source));

    expect(outcome!.status).toBe('INGESTED');
    expect(outcome!.factsInserted).toBe(3);
    expect(outcome!.statementAsOf?.toISOString()).toBe('2026-03-31T00:00:00.000Z');

    const facts = await new PgReserveFactStore(testPool()).listAllForIssuer(SEED_IDS.issuerId);
    expect(facts).toHaveLength(3);

    // Quoted thousands separators must survive as exact cents. A naive
    // split(',') would have shredded these into extra columns.
    const total = facts.reduce((sum, f) => sum + f.marketValueMinor, 0n);
    expect(total).toBe(1_048_037_000n); // 4,992,150.00 + 3,488,220.00 + 2,000,000.00

    const tbill = facts.find((f) => f.cusip === '912797KL0')!;
    expect(tbill.instrumentCategory).toBe('TBILL');
    expect(tbill.marketValueMinor).toBe(499_215_000n);
    expect(tbill.faceValueMinor).toBe(500_000_000n);
    expect(tbill.maturityDate?.toISOString()).toBe('2026-05-15T00:00:00.000Z');

    const cash = facts.find((f) => f.instrumentCategory === 'CASH')!;
    expect(cash.cusip).toBeNull();
    expect(cash.maturityDate).toBeNull();
  });

  it('records source-document lineage for every fact', async () => {
    source.add('bny-2026-03-31.csv', STATEMENT);
    const [outcome] = await worker.run(feed(source));

    const documents = new PgSourceDocumentStore(testPool());
    const document = await documents.findByContentHash(
      SEED_IDS.issuerId,
      (await documents.listForIssuer(SEED_IDS.issuerId))[0]!.contentHash,
    );
    expect(document!.id).toBe(outcome!.documentId);
    expect(document!.status).toBe('INGESTED');
    expect(document!.rowCount).toBe(3);
    expect(document!.filename).toBe('bny-2026-03-31.csv');

    // The evidentiary point: a figure traces back to the file it came from.
    const facts = await new PgReserveFactStore(testPool()).listAllForIssuer(SEED_IDS.issuerId);
    const lineage = await documents.findForFact(facts[0]!.id);
    expect(lineage?.id).toBe(document!.id);
  });

  it('gives each line its own provenance hash', async () => {
    source.add('bny-2026-03-31.csv', STATEMENT);
    await worker.run(feed(source));

    const facts = await new PgReserveFactStore(testPool()).listAllForIssuer(SEED_IDS.issuerId);
    const hashes = new Set(facts.map((f) => f.sourceHash));
    expect(hashes.size).toBe(3);
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats a redelivered file as a duplicate without reparsing', async () => {
    source.add('bny-2026-03-31.csv', STATEMENT);
    await worker.run(feed(source));

    source.add('bny-redelivered.csv', STATEMENT);
    const [outcome] = await worker.run(feed(source));

    expect(outcome!.status).toBe('DUPLICATE');
    expect(outcome!.factsInserted).toBe(0);
    expect(await new PgReserveFactStore(testPool()).listAllForIssuer(SEED_IDS.issuerId)).toHaveLength(3);
  });

  it('re-ingests identical lines as a no-op when the bytes differ', async () => {
    source.add('a.csv', STATEMENT);
    await worker.run(feed(source));

    // Same holdings, different bytes: the custodian re-sent the file with CRLF
    // line endings. The content hash misses, so dedupe has to happen at the row
    // level via the statement dedupe index.
    source.add('b.csv', STATEMENT.replace(/\n/g, '\r\n'));
    const [outcome] = await worker.run(feed(source));

    expect(outcome!.status).toBe('INGESTED');
    expect(outcome!.factsInserted).toBe(0);
    expect(outcome!.factsSkipped).toBe(3);
    expect(await new PgReserveFactStore(testPool()).listAllForIssuer(SEED_IDS.issuerId)).toHaveLength(3);
  });

  it('rejects a file with an unmappable value and writes nothing', async () => {
    source.add(
      'bad.csv',
      [
        'Asset Type,CUSIP,Par Value,Market Value,Maturity,Statement Date',
        '"US Treasury Bill",912797KL0,"5,000,000.00","not-a-number",2026-05-15,2026-03-31',
        '',
      ].join('\n'),
    );

    const [outcome] = await worker.run(feed(source));

    expect(outcome!.status).toBe('REJECTED');
    expect(outcome!.error).toMatch(/line 2/);
    // Atomicity: a partially-applied statement would read as a real position change.
    expect(await new PgReserveFactStore(testPool()).listAllForIssuer(SEED_IDS.issuerId)).toHaveLength(0);
    expect(source.failed[0]?.name).toBe('bad.csv');
  });

  it('rejects an unrecognised asset category rather than guessing', async () => {
    source.add(
      'bad.csv',
      [
        'Asset Type,CUSIP,Par Value,Market Value,Maturity,Statement Date',
        '"Corporate Bond",912797KL0,"5,000.00","5,000.00",2026-05-15,2026-03-31',
        '',
      ].join('\n'),
    );

    const [outcome] = await worker.run(feed(source));
    expect(outcome!.status).toBe('REJECTED');
    // Mapping it to OTHER would fire a false CRITICAL breach; mapping it to a
    // permitted category would hide a real one.
    expect(outcome!.error).toMatch(/Corporate Bond|category/i);
  });

  it('rejects a ragged row, which means a misaligned column', async () => {
    source.add(
      'ragged.csv',
      [
        'Asset Type,CUSIP,Par Value,Market Value,Maturity,Statement Date',
        '"US Treasury Bill",912797KL0,"5,000.00",2026-05-15,2026-03-31',
        '',
      ].join('\n'),
    );

    const [outcome] = await worker.run(feed(source));
    expect(outcome!.status).toBe('REJECTED');
    expect(outcome!.error).toMatch(/ragged|fields/i);
  });

  it('refuses a statement that mixes effective dates', async () => {
    source.add(
      'mixed.csv',
      [
        'Asset Type,CUSIP,Par Value,Market Value,Maturity,Statement Date',
        '"Demand Deposit",,"1,000.00","1,000.00",,2026-03-31',
        '"Demand Deposit",,"2,000.00","2,000.00",,2026-03-30',
        '',
      ].join('\n'),
    );

    const [outcome] = await worker.run(feed(source));
    expect(outcome!.status).toBe('REJECTED');
    // Two effective dates is not one position snapshot; picking either would
    // drop half the holdings during latest-statement selection.
    expect(outcome!.error).toMatch(/mixes effective dates/);
  });

  it('records a rejected document so the failure is auditable', async () => {
    source.add(
      'bad.csv',
      'Asset Type,CUSIP,Par Value,Market Value,Maturity,Statement Date\n"X",,"1","1",,2026-03-31\n',
    );
    await worker.run(feed(source));

    const [document] = await new PgSourceDocumentStore(testPool()).listForIssuer(SEED_IDS.issuerId);
    expect(document!.status).toBe('REJECTED');
    expect(document!.rejectionReason).toBeTruthy();
    expect(document!.statementAsOf).toBeNull();
  });

  it('keeps processing after one file fails', async () => {
    source.add('1-bad.csv', 'Asset Type\nnonsense\n', new Date('2026-03-31T10:00:00Z'));
    source.add('2-good.csv', STATEMENT, new Date('2026-03-31T11:00:00Z'));

    const outcomes = await worker.run(feed(source));

    expect(outcomes.map((o) => o.status)).toEqual(['REJECTED', 'INGESTED']);
    expect(await new PgReserveFactStore(testPool()).listAllForIssuer(SEED_IDS.issuerId)).toHaveLength(3);
  });

  it('derives the statement date from the filename when configured', async () => {
    source.add('bny-positions-2026-03-31.csv', STATEMENT);

    const [outcome] = await worker.run({
      ...feed(source),
      statementDate: { kind: 'filename', pattern: /(\d{4}-\d{2}-\d{2})/ },
    });

    expect(outcome!.status).toBe('INGESTED');
    expect(outcome!.statementAsOf?.toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  it('treats a header named after an Object prototype member as data', async () => {
    source.add(
      'proto.csv',
      [
        'constructor,Asset Type,Market Value,Statement Date',
        'x,"Demand Deposit","1,000.00",2026-03-31',
        '',
      ].join('\n'),
    );

    const [outcome] = await worker.run({
      ...feed(source),
      mapping: {
        columns: { category: 'Asset Type', marketValue: 'Market Value' },
        dateFormat: 'ISO',
        defaultCurrency: 'USD',
      },
    });

    expect(outcome!.status).toBe('INGESTED');
    expect(outcome!.factsInserted).toBe(1);
  });
});

describe('lineHash', () => {
  it('cannot be collided by re-splitting the same characters', () => {
    // ['a','bc'] and ['ab','c'] concatenate identically without a delimiter.
    expect(lineHash(['a', 'bc'])).not.toBe(lineHash(['ab', 'c']));
  });
});

describe.skipIf(!available)('supply observation worker', () => {
  let kaleido: FakeKaleidoClient;
  let worker: SupplyObservationWorker;

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
    kaleido = new FakeKaleidoClient();
    worker = new SupplyObservationWorker({
      pool: testPool(),
      kaleido,
      now: () => NOW,
      connectorIdFor: (d: TokenDeployment) => `conn-${d.chainId}`,
    });
  });

  const ETH = '0xaaaa000000000000000000000000000000000001';
  const BASE = '0xbbbb000000000000000000000000000000000002';

  function reading(supply: bigint, block: bigint) {
    return {
      totalSupply: supply,
      blockNumber: block,
      blockTimestamp: new Date('2026-03-31T23:50:00.000Z'),
    };
  }

  it('records supply for every active deployment', async () => {
    kaleido.setSupply(ETH, reading(7_000_000_000_000n, 21_500_000n));
    kaleido.setSupply(BASE, reading(3_000_000_000_000n, 12_000_000n));

    const outcomes = await worker.run(SEED_IDS.issuerId);

    expect(outcomes.map((o) => o.status)).toEqual(['RECORDED', 'RECORDED']);
    const facts = await new PgSupplyFactStore(testPool()).listForIssuerAsOf(
      SEED_IDS.issuerId,
      new Date('2026-04-01T00:00:00.000Z'),
    );
    expect(facts).toHaveLength(2);
    expect(facts.map((f) => f.totalSupply).sort()).toEqual([3_000_000_000_000n, 7_000_000_000_000n]);
  });

  it('reports UNCHANGED when the same block is polled again', async () => {
    kaleido.setSupply(ETH, reading(7_000_000_000_000n, 21_500_000n));
    kaleido.setSupply(BASE, reading(3_000_000_000_000n, 12_000_000n));

    await worker.run(SEED_IDS.issuerId);
    const second = await worker.run(SEED_IDS.issuerId);

    expect(second.every((o) => o.status === 'UNCHANGED')).toBe(true);
  });

  it('flags a contradictory supply at an already-observed block', async () => {
    kaleido.setSupply(ETH, reading(7_000_000_000_000n, 21_500_000n));
    kaleido.setSupply(BASE, reading(3_000_000_000_000n, 12_000_000n));
    await worker.run(SEED_IDS.issuerId);

    // A reorg or a faulty indexer: same block, different supply.
    kaleido.setSupply(ETH, reading(9_999_000_000_000n, 21_500_000n));
    const outcomes = await worker.run(SEED_IDS.issuerId);

    const eth = outcomes.find((o) => o.contractAddress === ETH)!;
    expect(eth.status).toBe('CONFLICT');
    expect(eth.error).toMatch(/conflicting supply/);
  });

  it('keeps polling other chains when one is unreachable', async () => {
    kaleido.setSupply(BASE, reading(3_000_000_000_000n, 12_000_000n));
    // ETH deliberately unconfigured: the fake throws for it.

    const outcomes = await worker.run(SEED_IDS.issuerId);

    expect(outcomes.find((o) => o.contractAddress === ETH)!.status).toBe('FAILED');
    expect(outcomes.find((o) => o.contractAddress === BASE)!.status).toBe('RECORDED');
  });

  it('names the deployments that would block certification', async () => {
    kaleido.setSupply(BASE, reading(3_000_000_000_000n, 12_000_000n));
    await worker.run(SEED_IDS.issuerId);

    const missing = await findUnobservedDeployments(
      testPool(),
      SEED_IDS.issuerId,
      new Date('2026-04-01T00:00:00.000Z'),
    );

    expect(missing).toHaveLength(1);
    expect(missing[0]!.contractAddress).toBe(ETH);
  });
});
