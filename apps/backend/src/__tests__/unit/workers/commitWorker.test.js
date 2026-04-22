// Mock all dependencies before requiring the worker
jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  init: jest.fn(),
}));

jest.mock('../../../../prisma/prisma', () => ({
  stagedImport: {
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  stagedImportRow: {
    findMany: jest.fn(),
    count: jest.fn(),
    updateMany: jest.fn(),
  },
  transaction: {
    createMany: jest.fn(),
    findMany: jest.fn(),
  },
  transactionTag: {
    createMany: jest.fn(),
  },
}));

jest.mock('../../../utils/transactionHash', () => ({
  computeTransactionHash: jest.fn().mockImplementation(
    (date, desc, amount, accountId) => `hash-${desc}-${amount}-${accountId}`
  ),
}));

jest.mock('../../../utils/tagUtils', () => ({
  resolveTagsByName: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../../services/categorizationService', () => ({
  recordFeedback: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../utils/descriptionCache', () => ({
  addDescriptionEntry: jest.fn(),
}));

jest.mock('../../../queues/eventsQueue', () => ({
  enqueueEvent: jest.fn().mockResolvedValue(undefined),
}));

const prisma = require('../../../../prisma/prisma');
const logger = require('../../../utils/logger');
const Sentry = require('@sentry/node');
const { computeTransactionHash } = require('../../../utils/transactionHash');
const { resolveTagsByName } = require('../../../utils/tagUtils');
const categorizationService = require('../../../services/categorizationService');
const { addDescriptionEntry } = require('../../../utils/descriptionCache');
const { enqueueEvent } = require('../../../queues/eventsQueue');

const { processCommitJob } = require('../../../workers/commitWorker');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeJob(data = {}) {
  return {
    id: 'test-commit-job-1',
    name: 'commit-smart-import',
    data: {
      tenantId: 'tenant-1',
      userId: 'user-1',
      stagedImportId: 'si-1',
      rowIds: null,
      ...data,
    },
    updateProgress: jest.fn().mockResolvedValue(undefined),
  };
}

function makeRow(overrides = {}) {
  return {
    id: 'row-1',
    stagedImportId: 'si-1',
    rowNumber: 1,
    transactionDate: '2026-01-15T00:00:00.000Z',
    description: 'Test purchase',
    details: '',
    debit: '50.00',
    credit: null,
    currency: 'USD',
    accountId: 1,
    suggestedCategoryId: 10,
    confidence: 0.95,
    classificationSource: 'EXACT_MATCH',
    status: 'CONFIRMED',
    requiresEnrichment: false,
    ticker: null,
    assetQuantity: null,
    assetPrice: null,
    tags: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('commitWorker — processCommitJob', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    // Re-apply default mock implementations cleared by resetAllMocks
    prisma.stagedImport.update.mockResolvedValue({});
    prisma.stagedImportRow.updateMany.mockResolvedValue({ count: 0 });
    // Baseline: findMany returns []. Tests that need specific results chain
    // .mockResolvedValueOnce() — they take precedence over this default.
    // Order of findMany calls per batch: (1) pre-existing externalIds check,
    // (2) committed-row → txId lookup (used for tag-linking + embedding FK).
    prisma.transaction.findMany.mockResolvedValue([]);
    computeTransactionHash.mockImplementation(
      (date, desc, amount, accountId) => `hash-${desc}-${amount}-${accountId}`
    );
    categorizationService.recordFeedback.mockResolvedValue(undefined);
    addDescriptionEntry.mockReset();
    resolveTagsByName.mockResolvedValue([]);
    enqueueEvent.mockResolvedValue(undefined);
  });

  // ─── Validation ─────────────────────────────────────────────────────────

  it('throws when StagedImport not found', async () => {
    prisma.stagedImport.findFirst.mockResolvedValueOnce(null);

    const job = makeJob();
    await expect(processCommitJob(job)).rejects.toThrow('StagedImport si-1 not found');

    // Should set status to ERROR
    expect(prisma.stagedImport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'si-1' },
        data: expect.objectContaining({ status: 'ERROR' }),
      })
    );
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('throws when status is not COMMITTING', async () => {
    prisma.stagedImport.findFirst.mockResolvedValueOnce({
      id: 'si-1',
      tenantId: 'tenant-1',
      status: 'READY',
    });

    const job = makeJob();
    await expect(processCommitJob(job)).rejects.toThrow('expected "COMMITTING"');

    expect(prisma.stagedImport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'ERROR' }),
      })
    );
  });

  // ─── Empty commit ───────────────────────────────────────────────────────

  it('handles empty commit (0 CONFIRMED rows) and sets COMMITTED when no remaining', async () => {
    prisma.stagedImport.findFirst.mockResolvedValueOnce({
      id: 'si-1',
      tenantId: 'tenant-1',
      status: 'COMMITTING',
    });
    prisma.stagedImportRow.findMany.mockResolvedValueOnce([]);
    prisma.stagedImportRow.count
      .mockResolvedValueOnce(0)   // totalConfirmed
      .mockResolvedValueOnce(0);  // remainingCount

    const job = makeJob();
    const result = await processCommitJob(job);

    expect(result).toEqual({ stagedImportId: 'si-1', transactionCount: 0, remaining: 0 });

    // Should set status to COMMITTED with commitResult
    expect(prisma.stagedImport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'COMMITTED',
          progress: 100,
          errorDetails: { commitResult: { transactionCount: 0, updateCount: 0, remaining: 0 } },
        }),
      })
    );
  });

  it('handles empty commit and sets READY when remaining rows exist', async () => {
    prisma.stagedImport.findFirst.mockResolvedValueOnce({
      id: 'si-1',
      tenantId: 'tenant-1',
      status: 'COMMITTING',
    });
    prisma.stagedImportRow.findMany.mockResolvedValueOnce([]);
    prisma.stagedImportRow.count
      .mockResolvedValueOnce(0)   // totalConfirmed
      .mockResolvedValueOnce(5);  // remainingCount

    const job = makeJob();
    const result = await processCommitJob(job);

    expect(result).toEqual({ stagedImportId: 'si-1', transactionCount: 0, remaining: 5 });
    expect(prisma.stagedImport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'READY' }),
      })
    );
  });

  // ─── Batch transaction creation ─────────────────────────────────────────

  it('creates transactions in batches and marks rows as SKIPPED', async () => {
    const rows = [
      makeRow({ id: 'row-1', rowNumber: 1 }),
      makeRow({ id: 'row-2', rowNumber: 2, description: 'Another purchase', debit: '25.00' }),
    ];

    prisma.stagedImport.findFirst.mockResolvedValueOnce({
      id: 'si-1',
      tenantId: 'tenant-1',
      status: 'COMMITTING',
    });
    prisma.stagedImportRow.count.mockResolvedValueOnce(2);  // totalConfirmed
    prisma.stagedImportRow.findMany
      .mockResolvedValueOnce(rows)   // first batch
      .mockResolvedValueOnce([]);    // second batch (exit loop)
    prisma.transaction.findMany.mockResolvedValueOnce([]);   // pre-existing externalIds check
    prisma.transaction.createMany.mockResolvedValueOnce({ count: 2 });
    prisma.stagedImportRow.count.mockResolvedValueOnce(0);   // remainingCount

    const job = makeJob();
    const result = await processCommitJob(job);

    expect(result.transactionCount).toBe(2);
    expect(result.remaining).toBe(0);

    // Verify createMany was called with transaction data
    expect(prisma.transaction.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            description: 'Test purchase',
            tenantId: 'tenant-1',
            source: 'CSV',
          }),
        ]),
        skipDuplicates: true,
      })
    );

    // Verify rows marked as SKIPPED
    expect(prisma.stagedImportRow.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['row-1', 'row-2'] } },
      data: { status: 'SKIPPED' },
    });

    // Verify TRANSACTIONS_IMPORTED event enqueued
    expect(enqueueEvent).toHaveBeenCalledWith(
      'TRANSACTIONS_IMPORTED',
      expect.objectContaining({
        tenantId: 'tenant-1',
        source: 'SMART_IMPORT',
      })
    );
  });

  // ─── Enrichment skip ────────────────────────────────────────────────────

  it('skips rows requiring enrichment without ticker', async () => {
    const rows = [
      makeRow({ id: 'row-1', requiresEnrichment: true, ticker: null, assetQuantity: null, assetPrice: null }),
      makeRow({ id: 'row-2', requiresEnrichment: false, description: 'Normal purchase' }),
    ];

    prisma.stagedImport.findFirst.mockResolvedValueOnce({
      id: 'si-1',
      tenantId: 'tenant-1',
      status: 'COMMITTING',
    });
    prisma.stagedImportRow.count.mockResolvedValueOnce(2);  // totalConfirmed
    prisma.stagedImportRow.findMany
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([]);
    prisma.transaction.findMany.mockResolvedValueOnce([]);   // pre-existing check
    prisma.transaction.createMany.mockResolvedValueOnce({ count: 1 });
    prisma.stagedImportRow.count.mockResolvedValueOnce(0);   // remainingCount

    const job = makeJob();
    const result = await processCommitJob(job);

    // Only 1 transaction created (enrichment row skipped)
    expect(result.transactionCount).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipping row row-1')
    );
  });

  // ─── Feedback for LLM/USER_OVERRIDE ─────────────────────────────────────

  it('calls recordFeedback for LLM and USER_OVERRIDE rows only', async () => {
    const rows = [
      makeRow({ id: 'row-1', classificationSource: 'EXACT_MATCH', description: 'exact', debit: '10.00' }),
      makeRow({ id: 'row-2', classificationSource: 'LLM', description: 'llm-classified', debit: '20.00' }),
      makeRow({ id: 'row-3', classificationSource: 'USER_OVERRIDE', description: 'user-override', debit: '30.00' }),
      makeRow({ id: 'row-4', classificationSource: 'VECTOR_MATCH', description: 'vector', debit: '40.00' }),
    ];

    prisma.stagedImport.findFirst.mockResolvedValueOnce({
      id: 'si-1',
      tenantId: 'tenant-1',
      status: 'COMMITTING',
    });
    prisma.stagedImportRow.count.mockResolvedValueOnce(4);  // totalConfirmed
    prisma.stagedImportRow.findMany
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([]);
    prisma.transaction.findMany
      .mockResolvedValueOnce([])  // pre-existing externalIds check
      .mockResolvedValueOnce([    // committed-row → txId lookup
        { id: 1001, externalId: 'hash-exact-10.00-1' },
        { id: 1002, externalId: 'hash-llm-classified-20.00-1' },
        { id: 1003, externalId: 'hash-user-override-30.00-1' },
        { id: 1004, externalId: 'hash-vector-40.00-1' },
      ]);
    prisma.transaction.createMany.mockResolvedValueOnce({ count: 4 });
    prisma.stagedImportRow.count.mockResolvedValueOnce(0);   // remainingCount

    const job = makeJob();
    await processCommitJob(job);

    // recordFeedback should be called for LLM and USER_OVERRIDE rows only (2 of 4),
    // and must receive the committed Transaction.id so TransactionEmbedding.transactionId
    // gets populated (otherwise scripts/regenerate-embeddings.js can't recover plaintext).
    expect(categorizationService.recordFeedback).toHaveBeenCalledTimes(2);
    expect(categorizationService.recordFeedback).toHaveBeenCalledWith('llm-classified', 10, 'tenant-1', 1002);
    expect(categorizationService.recordFeedback).toHaveBeenCalledWith('user-override', 10, 'tenant-1', 1003);
  });

  // ─── Final status ───────────────────────────────────────────────────────

  it('sets final status to COMMITTED when remaining = 0', async () => {
    prisma.stagedImport.findFirst.mockResolvedValueOnce({
      id: 'si-1',
      tenantId: 'tenant-1',
      status: 'COMMITTING',
    });
    prisma.stagedImportRow.count.mockResolvedValueOnce(1);   // totalConfirmed
    prisma.stagedImportRow.findMany
      .mockResolvedValueOnce([makeRow()])
      .mockResolvedValueOnce([]);
    prisma.transaction.findMany.mockResolvedValueOnce([]);    // pre-existing check
    prisma.transaction.createMany.mockResolvedValueOnce({ count: 1 });
    prisma.stagedImportRow.count.mockResolvedValueOnce(0);   // remainingCount

    const job = makeJob();
    const result = await processCommitJob(job);

    expect(result.remaining).toBe(0);

    // Find the final update call (the one setting status to COMMITTED)
    const finalCall = prisma.stagedImport.update.mock.calls.find(
      (c) => c[0].data.status === 'COMMITTED'
    );
    expect(finalCall).toBeDefined();
    expect(finalCall[0].data.progress).toBe(100);
    expect(finalCall[0].data.errorDetails).toEqual({
      commitResult: { transactionCount: 1, updateCount: 0, remaining: 0 },
    });
  });

  it('sets final status to READY when remaining > 0', async () => {
    prisma.stagedImport.findFirst.mockResolvedValueOnce({
      id: 'si-1',
      tenantId: 'tenant-1',
      status: 'COMMITTING',
    });
    prisma.stagedImportRow.count.mockResolvedValueOnce(1);   // totalConfirmed
    prisma.stagedImportRow.findMany
      .mockResolvedValueOnce([makeRow()])
      .mockResolvedValueOnce([]);
    prisma.transaction.findMany.mockResolvedValueOnce([]);    // pre-existing check
    prisma.transaction.createMany.mockResolvedValueOnce({ count: 1 });
    prisma.stagedImportRow.count.mockResolvedValueOnce(3);   // remainingCount

    const job = makeJob();
    const result = await processCommitJob(job);

    expect(result.remaining).toBe(3);

    const finalCall = prisma.stagedImport.update.mock.calls.find(
      (c) => c[0].data.status === 'READY'
    );
    expect(finalCall).toBeDefined();
  });

  // ─── Error handling ─────────────────────────────────────────────────────

  it('sets status to ERROR on exception', async () => {
    prisma.stagedImport.findFirst.mockRejectedValueOnce(new Error('DB connection lost'));

    const job = makeJob();
    await expect(processCommitJob(job)).rejects.toThrow('DB connection lost');

    expect(prisma.stagedImport.update).toHaveBeenCalledWith({
      where: { id: 'si-1' },
      data: {
        status: 'ERROR',
        progress: 0,
        errorDetails: { message: 'DB connection lost' },
      },
    });
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  // ─── Tag linking ────────────────────────────────────────────────────────

  it('links tags to created transactions', async () => {
    const rows = [
      makeRow({ id: 'row-1', tags: ['Business', 'Travel'] }),
    ];

    prisma.stagedImport.findFirst.mockResolvedValueOnce({
      id: 'si-1',
      tenantId: 'tenant-1',
      status: 'COMMITTING',
    });
    prisma.stagedImportRow.count.mockResolvedValueOnce(1);   // totalConfirmed
    prisma.stagedImportRow.findMany
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([]);
    prisma.transaction.findMany
      .mockResolvedValueOnce([])   // pre-existing externalIds check
      .mockResolvedValueOnce([     // tag-linking: find created transactions by externalId
        { id: 999, externalId: 'hash-Test purchase-50.00-1' },
      ]);
    prisma.transaction.createMany.mockResolvedValueOnce({ count: 1 });
    resolveTagsByName.mockResolvedValueOnce([
      { id: 101, name: 'Business' },
      { id: 102, name: 'Travel' },
    ]);
    prisma.stagedImportRow.count.mockResolvedValueOnce(0);   // remainingCount

    const job = makeJob();
    await processCommitJob(job);

    // Verify resolveTagsByName was called
    expect(resolveTagsByName).toHaveBeenCalledWith(
      ['Business', 'Travel'],
      'tenant-1',
      'user-1'
    );

    // Verify tag links created
    expect(prisma.transactionTag.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        { transactionId: 999, tagId: 101 },
        { transactionId: 999, tagId: 102 },
      ]),
      skipDuplicates: true,
    });
  });

  // ─── Occurrence counter for identical transactions ──────────────────

  it('commits all confirmed rows with same hash by appending occurrence counters to externalId', async () => {
    // Simulate 3 identical "$1 Commission" rows on the same day — all CONFIRMED.
    // computeTransactionHash returns the same base hash for all 3.
    computeTransactionHash.mockReturnValue('commission-hash');

    const rows = [
      makeRow({ id: 'row-1', rowNumber: 1, description: 'Commission', debit: '1.00' }),
      makeRow({ id: 'row-2', rowNumber: 2, description: 'Commission', debit: '1.00' }),
      makeRow({ id: 'row-3', rowNumber: 3, description: 'Commission', debit: '1.00' }),
    ];

    prisma.stagedImport.findFirst.mockResolvedValueOnce({
      id: 'si-1',
      tenantId: 'tenant-1',
      status: 'COMMITTING',
    });
    prisma.stagedImportRow.count.mockResolvedValueOnce(3);   // totalConfirmed
    prisma.stagedImportRow.findMany
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([]);
    prisma.transaction.findMany.mockResolvedValueOnce([]);    // pre-existing check
    prisma.transaction.createMany.mockResolvedValueOnce({ count: 3 }); // all 3 created!
    prisma.stagedImportRow.count.mockResolvedValueOnce(0);   // remainingCount

    const job = makeJob();
    const result = await processCommitJob(job);

    // All 3 transactions created
    expect(result.transactionCount).toBe(3);

    // Verify createMany was called with 3 unique externalIds
    const createCall = prisma.transaction.createMany.mock.calls[0][0];
    const externalIds = createCall.data.map((d) => d.externalId);
    expect(externalIds).toEqual([
      'commission-hash',     // 1st occurrence: base hash
      'commission-hash:2',   // 2nd occurrence
      'commission-hash:3',   // 3rd occurrence
    ]);

    // All rows committed → SKIPPED
    expect(prisma.stagedImportRow.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['row-1', 'row-2', 'row-3'] } },
      data: { status: 'SKIPPED' },
    });
  });

  it('detects pre-existing occurrence-suffixed externalIds on re-import', async () => {
    // Re-importing a CSV with 2 identical commissions that already exist in the DB.
    computeTransactionHash.mockReturnValue('commission-hash');

    const rows = [
      makeRow({ id: 'row-1', rowNumber: 1, description: 'Commission', debit: '1.00' }),
      makeRow({ id: 'row-2', rowNumber: 2, description: 'Commission', debit: '1.00' }),
    ];

    prisma.stagedImport.findFirst.mockResolvedValueOnce({
      id: 'si-1',
      tenantId: 'tenant-1',
      status: 'COMMITTING',
    });
    prisma.stagedImportRow.count.mockResolvedValueOnce(2);   // totalConfirmed
    prisma.stagedImportRow.findMany
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([]);
    // Both externalIds already exist in DB from a previous import
    prisma.transaction.findMany.mockResolvedValueOnce([
      { externalId: 'commission-hash' },
      { externalId: 'commission-hash:2' },
    ]);
    prisma.transaction.createMany.mockResolvedValueOnce({ count: 0 }); // none created
    prisma.stagedImportRow.count.mockResolvedValueOnce(0);   // remainingCount

    const job = makeJob();
    const result = await processCommitJob(job);

    expect(result.transactionCount).toBe(0);

    // Both rows flagged as POTENTIAL_DUPLICATE
    expect(prisma.stagedImportRow.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['row-1', 'row-2'] } },
      data: { status: 'POTENTIAL_DUPLICATE' },
    });
  });

  it('includes POTENTIAL_DUPLICATE rows in commit (not just CONFIRMED)', async () => {
    // Rows flagged as POTENTIAL_DUPLICATE should be processed by the commit worker
    // without requiring the user to individually approve each one first.
    const rows = [
      makeRow({ id: 'row-1', status: 'POTENTIAL_DUPLICATE', description: 'Commission', debit: '1.00' }),
      makeRow({ id: 'row-2', status: 'CONFIRMED', description: 'Groceries', debit: '50.00' }),
    ];

    prisma.stagedImport.findFirst.mockResolvedValueOnce({
      id: 'si-1',
      tenantId: 'tenant-1',
      status: 'COMMITTING',
    });
    prisma.stagedImportRow.count.mockResolvedValueOnce(2);   // totalConfirmed (includes both)
    prisma.stagedImportRow.findMany
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([]);
    prisma.transaction.findMany.mockResolvedValueOnce([]);    // pre-existing check
    prisma.transaction.createMany.mockResolvedValueOnce({ count: 2 });
    prisma.stagedImportRow.count.mockResolvedValueOnce(0);   // remainingCount

    const job = makeJob();
    const result = await processCommitJob(job);

    // Both rows should be committed
    expect(result.transactionCount).toBe(2);

    // Verify the rowWhere query includes both statuses
    const countCall = prisma.stagedImportRow.count.mock.calls[0][0];
    expect(countCall.where.status).toEqual({ in: ['CONFIRMED', 'POTENTIAL_DUPLICATE'] });
  });

  // ─── DescriptionMapping write-through ──────────────────────────────────

  it('calls addDescriptionEntry for ALL committed rows regardless of classificationSource', async () => {
    const exactRow = makeRow({ id: 'row-exact', classificationSource: 'EXACT_MATCH', description: 'Coffee Shop', suggestedCategoryId: 10 });
    const vectorRow = makeRow({ id: 'row-vector', classificationSource: 'VECTOR_MATCH', description: 'AMZN Purchase', suggestedCategoryId: 20 });
    const llmRow = makeRow({ id: 'row-llm', classificationSource: 'LLM', description: 'New Merchant', suggestedCategoryId: 30 });

    prisma.stagedImport.findFirst.mockResolvedValueOnce({
      id: 'si-1', tenantId: 'tenant-1', status: 'COMMITTING',
    });
    prisma.stagedImportRow.findMany
      .mockResolvedValueOnce([exactRow, vectorRow, llmRow])
      .mockResolvedValueOnce([]);
    prisma.stagedImportRow.count
      .mockResolvedValueOnce(3)  // totalConfirmed
      .mockResolvedValueOnce(0); // remainingCount
    prisma.transaction.createMany.mockResolvedValueOnce({ count: 3 });
    prisma.transaction.findMany.mockResolvedValueOnce([
      { id: 1, externalId: `hash-Coffee Shop-50-1` },
      { id: 2, externalId: `hash-AMZN Purchase-50-1` },
      { id: 3, externalId: `hash-New Merchant-50-1` },
    ]);

    const job = makeJob();
    await processCommitJob(job);

    // addDescriptionEntry should be called for ALL 3 rows (not just LLM/USER_OVERRIDE)
    expect(addDescriptionEntry).toHaveBeenCalledTimes(3);
    expect(addDescriptionEntry).toHaveBeenCalledWith('Coffee Shop', 10, 'tenant-1');
    expect(addDescriptionEntry).toHaveBeenCalledWith('AMZN Purchase', 20, 'tenant-1');
    expect(addDescriptionEntry).toHaveBeenCalledWith('New Merchant', 30, 'tenant-1');
  });
});
