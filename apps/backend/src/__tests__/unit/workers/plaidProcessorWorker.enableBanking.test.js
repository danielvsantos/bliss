/**
 * plaidProcessorWorker with Enable Banking rows (#132): the boundary-day hash
 * dedupe against existing Plaid-sourced history (R11a), the provider-aware
 * promotion label (D3) and the duplicate count written back to the sync log.
 */

jest.mock('../../../queues/plaidProcessingQueue', () => ({
  getPlaidProcessingQueue: jest.fn().mockReturnValue({ add: jest.fn().mockResolvedValue({}) }),
}));
jest.mock('../../../utils/redis', () => ({ getRedisConnection: jest.fn().mockReturnValue({}) }));
jest.mock('../../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../../utils/activityTracker', () => ({ trackWorker: jest.fn() }));

jest.mock('bullmq', () => ({ Worker: jest.fn() }));

const mockPrisma = {
  plaidTransaction: { update: jest.fn(), updateMany: jest.fn(), findMany: jest.fn() },
  plaidItem: { findUnique: jest.fn(), update: jest.fn() },
  plaidSyncLog: { findFirst: jest.fn(), update: jest.fn() },
  $transaction: jest.fn(),
};
jest.mock('../../../../prisma/prisma', () => mockPrisma);

jest.mock('../../../services/categorizationService', () => ({ classify: jest.fn(), recordFeedback: jest.fn() }));
jest.mock('../../../utils/descriptionCache', () => ({ warmDescriptionCache: jest.fn() }));
jest.mock('../../../utils/categoryCache', () => ({
  getCategoriesForTenant: jest.fn().mockResolvedValue([{ id: 7, type: 'Essentials', processingHint: null }]),
}));
jest.mock('../../../services/llm', () => ({ isRateLimitError: jest.fn().mockReturnValue(false) }));

// The real hash (its Prisma import is mocked above), so the test proves the
// Enable Banking label hashes identically to the existing Plaid-sourced rows.
jest.mock('../../../utils/transactionHash', () => ({
  ...jest.requireActual('../../../utils/transactionHash'),
  buildDuplicateHashSet: jest.fn(),
}));

const { computeTransactionHash } = require('../../../utils/transactionHash');
const { checkHashDuplicate, processRowWithResult, recordOutcomeOnSyncLog } = require('../../../workers/plaidProcessorWorker');

const JOINT = 3603;
const DANIEL = 3604;
const DAY = '2026-10-10';

// Existing Plaid-sourced Bliss transactions on the boundary day.
const EXISTING = [
  [JOINT, 'Caprabo', 4.78],
  [JOINT, 'Fruites Josuna S.l.', 7.66],
  [DANIEL, 'Premium Repricing 1 plan fee', 9.99],
];

let nextId = 1;
function ebRow(hash, name, amount, merchantName) {
  const id = nextId++;
  return {
    id: `ptx-${id}`,
    name,
    merchantName,
    amount,
    date: new Date(`${DAY}T00:00:00Z`),
    isoCurrencyCode: 'EUR',
    plaidAccountId: `eb:${hash}`,
    plaidTransactionId: `eb:${hash}:ref-${id}`,
    category: 'CARD_PAYMENT',
    classificationRetryCount: 0,
  };
}

const ROWS = [
  // Hash-match existing rows on the remittance text (D3), not the counterparty.
  ebRow('h-joint', 'Caprabo', 4.78, 'CAPRABO SA'),
  ebRow('h-joint', 'Fruites Josuna S.l.', 7.66, 'FRUITES JOSUNA SL'),
  ebRow('h-daniel', 'Premium Repricing 1 plan fee', 9.99, null),
  // The four joint-account rows Plaid missed.
  ebRow('h-joint', 'Taxi Lic 1137', 10.7, 'TAXI'),
  ebRow('h-joint', 'Villarroel', 27.5, 'VILLARROEL'),
  ebRow('h-joint', 'Sant Sadurni', 50, 'SANT SADURNI'),
  ebRow('h-joint', 'La Furgo', 52.98, 'LA FURGO'),
];


function makeCtx(provider = 'ENABLE_BANKING') {
  const accountByPlaidAccountId = new Map([
    ['eb:h-joint', { id: JOINT, plaidAccountId: 'eb:h-joint' }],
    ['eb:h-daniel', { id: DANIEL, plaidAccountId: 'eb:h-daniel' }],
  ]);
  const hashSetByAccountId = new Map([JOINT, DANIEL].map(acc => [acc, new Set(
    EXISTING.filter(([a]) => a === acc).map(([a, desc, amt]) => computeTransactionHash(new Date(DAY), desc, amt, a)),
  )]));
  return {
    tenantId: 't1',
    autoPromoteThreshold: 0.9,
    reviewThreshold: 0.7,
    categoryById: new Map([[7, { id: 7, type: 'Essentials', processingHint: null }]]),
    accountByPlaidAccountId,
    existingByExternalId: new Map(),
    hashSetByAccountId,
    counters: {
      totalClassified: 0, totalAutoPromoted: 0, totalFailed: 0, totalRateLimited: 0,
      totalRetryScheduled: 0, totalDuplicates: 0, autoPromotedAccountIds: new Set(),
      autoPromotedMinYear: null, autoPromotedMinMonth: null,
    },
    feedbackCalls: [],
    provider,
  };
}

const RESULT = { categoryId: 7, confidence: 0.8, source: 'LLM' };

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.plaidTransaction.update.mockResolvedValue({});
  mockPrisma.plaidSyncLog.findFirst.mockResolvedValue({ id: 'log-1', details: { added: 7 } });
  mockPrisma.plaidSyncLog.update.mockResolvedValue({});
});

it('marks the three boundary-day rows DUPLICATE and keeps the four missing ones for review', async () => {
  const ctx = makeCtx();
  for (const row of ROWS) await processRowWithResult(row, RESULT, ctx);

  const statusById = new Map(mockPrisma.plaidTransaction.update.mock.calls.map(([a]) => [a.where.id, a.data.promotionStatus]));
  expect(Object.fromEntries(ROWS.map(r => [r.name, statusById.get(r.id)]))).toEqual({
    'Caprabo': 'DUPLICATE',
    'Fruites Josuna S.l.': 'DUPLICATE',
    'Premium Repricing 1 plan fee': 'DUPLICATE',
    'Taxi Lic 1137': 'CLASSIFIED',
    'Villarroel': 'CLASSIFIED',
    'Sant Sadurni': 'CLASSIFIED',
    'La Furgo': 'CLASSIFIED',
  });
  expect(ctx.counters.totalDuplicates).toBe(3);

  // The originating sync log reports the duplicate count.
  await recordOutcomeOnSyncLog('log-1', 'eb-item', ctx.counters);
  expect(mockPrisma.plaidSyncLog.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'log-1', plaidItemId: 'eb-item' } }));
  expect(mockPrisma.plaidSyncLog.update).toHaveBeenCalledWith({
    where: { id: 'log-1' },
    data: { details: expect.objectContaining({ added: 7, duplicates: 3, classified: 7 }) },
  });
});

it('would miss the match if hashed on the counterparty (why D3 hashes the remittance text)', async () => {
  const caprabo = ROWS[0];
  // Plaid labelling (merchantName || name) hashes "CAPRABO SA" — no match.
  expect(await checkHashDuplicate(caprabo, RESULT, makeCtx('PLAID'))).toBe(false);
  expect(await checkHashDuplicate(caprabo, RESULT, makeCtx('ENABLE_BANKING'))).toBe(true);
});

it('promotes an Enable Banking row under its remittance text, not the counterparty name', async () => {
  const created = [];
  mockPrisma.$transaction.mockImplementation(async (fn) => fn({
    transaction: { create: jest.fn(async ({ data }) => { created.push(data); return { id: 99 }; }) },
    plaidTransaction: { update: jest.fn() },
  }));
  const ctx = makeCtx();
  await processRowWithResult(ROWS[3], { categoryId: 7, confidence: 0.95, source: 'EXACT_MATCH' }, ctx);

  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({
    description: 'Taxi Lic 1137',
    details: 'Taxi Lic 1137',
    debit: 10.7,
    credit: null,
    currency: 'EUR',
    accountId: JOINT,
    source: 'PLAID',
    externalId: ROWS[3].plaidTransactionId,
  });
  expect(ctx.feedbackCalls[0][0]).toBe('Taxi Lic 1137');
});

it('leaves Plaid promotion unchanged (merchantName || name)', async () => {
  const created = [];
  mockPrisma.$transaction.mockImplementation(async (fn) => fn({
    transaction: { create: jest.fn(async ({ data }) => { created.push(data); return { id: 1 }; }) },
    plaidTransaction: { update: jest.fn() },
  }));
  await processRowWithResult({ ...ROWS[3], name: 'SQ *GIRO BAR', merchantName: 'Giro Bar' }, { categoryId: 7, confidence: 0.95, source: 'EXACT_MATCH' }, makeCtx('PLAID'));
  expect(created[0].description).toBe('Giro Bar');
});

it('recordOutcomeOnSyncLog is a no-op without a syncLogId and never throws', async () => {
  await recordOutcomeOnSyncLog(undefined, 'x', makeCtx().counters);
  expect(mockPrisma.plaidSyncLog.findFirst).not.toHaveBeenCalled();
  mockPrisma.plaidSyncLog.findFirst.mockRejectedValueOnce(new Error('db'));
  await expect(recordOutcomeOnSyncLog('log-1', 'x', makeCtx().counters)).resolves.toBeUndefined();
});
