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

jest.mock('../../../../prisma/prisma', () => ({}));

jest.mock('@bliss/shared/storage', () => ({
  createStorageAdapter: jest.fn(),
}));

jest.mock('../../../services/adapterEngine', () => ({
  parseFile: jest.fn(),
}));

jest.mock('../../../services/twelveDataService', () => ({}));
jest.mock('../../../services/cryptoService', () => ({}));
jest.mock('../../../services/securityMasterService', () => ({}));
jest.mock('../../../services/categorizationService', () => ({
  classifyTransaction: jest.fn(),
}));

jest.mock('../../../utils/descriptionCache', () => ({
  warmDescriptionCache: jest.fn(),
}));

jest.mock('../../../utils/categoryCache', () => ({
  getCategoriesForTenant: jest.fn(),
}));

jest.mock('../../../utils/transactionHash', () => ({
  computeTransactionHash: jest.fn(),
  buildDuplicateHashSet: jest.fn(),
}));

jest.mock('../../../utils/redis', () => ({
  getRedisConnection: jest.fn().mockReturnValue({}),
}));

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn(),
  })),
}));

jest.mock('../../../queues/smartImportQueue', () => ({
  SMART_IMPORT_QUEUE_NAME: 'test-smart-import',
}));

const {
  applyClassificationToRowData,
  applyDuplicateStatus,
  computeUpdateDiff,
  buildAiFrequencyMap,
} = require('../../../workers/smartImportWorker');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('smartImportWorker — helper functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── applyClassificationToRowData ──────────────────────────────────────────

  describe('applyClassificationToRowData', () => {
    const makeCategoryMap = () => {
      const map = new Map();
      map.set(10, { id: 10, name: 'Groceries', type: 'Essentials', processingHint: null });
      map.set(20, { id: 20, name: 'Stocks', type: 'Investments', processingHint: 'API_STOCK' });
      map.set(30, { id: 30, name: 'Savings', type: 'Asset', processingHint: 'CASH' });
      return map;
    };

    it('sets confidence, source, and categoryId on rowData', () => {
      const rowData = { status: 'PENDING' };
      const result = { categoryId: 10, confidence: 0.85, source: 'LLM' };
      const categoryById = makeCategoryMap();

      applyClassificationToRowData(rowData, result, 0.90, categoryById);

      expect(rowData.suggestedCategoryId).toBe(10);
      expect(rowData.confidence).toBe(0.85);
      expect(rowData.classificationSource).toBe('LLM');
    });

    it('auto-confirms when confidence >= threshold and not an investment', () => {
      const rowData = { status: 'PENDING' };
      const result = { categoryId: 10, confidence: 0.95, source: 'EXACT_MATCH' };
      const categoryById = makeCategoryMap();

      const wasAutoConfirmed = applyClassificationToRowData(rowData, result, 0.90, categoryById);

      expect(wasAutoConfirmed).toBe(true);
      expect(rowData.status).toBe('CONFIRMED');
      expect(rowData.classificationSource).toBe('EXACT_MATCH');
    });

    it('preserves AI source on auto-confirm (does not overwrite with USER_OVERRIDE)', () => {
      const rowData = { status: 'PENDING' };
      const result = { categoryId: 10, confidence: 0.92, source: 'VECTOR_MATCH_GLOBAL' };
      const categoryById = makeCategoryMap();

      applyClassificationToRowData(rowData, result, 0.90, categoryById);

      expect(rowData.status).toBe('CONFIRMED');
      expect(rowData.classificationSource).toBe('VECTOR_MATCH_GLOBAL');
    });

    it('does NOT auto-confirm when confidence < threshold', () => {
      const rowData = { status: 'PENDING' };
      const result = { categoryId: 10, confidence: 0.80, source: 'VECTOR_MATCH' };
      const categoryById = makeCategoryMap();

      const wasAutoConfirmed = applyClassificationToRowData(rowData, result, 0.90, categoryById);

      expect(wasAutoConfirmed).toBeFalsy();
      expect(rowData.status).toBe('PENDING');
    });

    it('does NOT auto-confirm investment categories regardless of confidence', () => {
      const rowData = { status: 'PENDING' };
      const result = { categoryId: 20, confidence: 1.0, source: 'EXACT_MATCH' };
      const categoryById = makeCategoryMap();

      const wasAutoConfirmed = applyClassificationToRowData(rowData, result, 0.90, categoryById);

      expect(wasAutoConfirmed).toBeFalsy();
      expect(rowData.status).toBe('PENDING');
      expect(rowData.requiresEnrichment).toBe(true);
      expect(rowData.enrichmentType).toBe('INVESTMENT');
    });

    it('does NOT auto-confirm when row status is not PENDING', () => {
      const rowData = { status: 'CONFIRMED' };
      const result = { categoryId: 10, confidence: 0.99, source: 'EXACT_MATCH' };
      const categoryById = makeCategoryMap();

      const wasAutoConfirmed = applyClassificationToRowData(rowData, result, 0.90, categoryById);

      expect(wasAutoConfirmed).toBeFalsy();
      expect(rowData.status).toBe('CONFIRMED'); // unchanged
    });
  });

  // ─── computeUpdateDiff ─────────────────────────────────────────────────────

  describe('computeUpdateDiff', () => {
    const makeCategoryMap = () => {
      const map = new Map();
      map.set(10, { id: 10, name: 'Groceries' });
      map.set(20, { id: 20, name: 'Dining' });
      return map;
    };

    it('detects changes between CSV and existing transaction', () => {
      const csvRow = {
        description: 'Updated Coffee Shop',
        details: 'new details',
        debit: '55.00',
        credit: null,
        date: '2026-01-15',
        currency: 'USD',
        tags: ['Business'],
        ticker: null,
        assetQuantity: null,
        assetPrice: null,
      };
      const existingTx = {
        description: 'Coffee Shop',
        details: null,
        debit: 50.00,
        credit: null,
        categoryId: 10,
        transaction_date: new Date('2026-01-15'),
        currency: 'USD',
        tags: [],
        ticker: null,
        assetQuantity: null,
        assetPrice: null,
      };
      const categoryById = makeCategoryMap();

      const diff = computeUpdateDiff(csvRow, existingTx, 20, categoryById);

      expect(diff.description).toBeDefined();
      expect(diff.description.old).toBe('Coffee Shop');
      expect(diff.description.new).toBe('Updated Coffee Shop');
      expect(diff.details).toBeDefined();
      expect(diff.debit).toBeDefined();
      expect(diff.categoryId).toBeDefined();
      expect(diff.categoryId.oldName).toBe('Groceries');
      expect(diff.categoryId.newName).toBe('Dining');
      expect(diff.tags).toBeDefined();
    });

    it('returns empty object when no changes detected', () => {
      const csvRow = {
        description: 'Coffee Shop',
        details: null,
        debit: '50',
        credit: null,
        date: '2026-01-15',
        currency: 'USD',
        tags: [],
        ticker: null,
        assetQuantity: null,
        assetPrice: null,
      };
      const existingTx = {
        description: 'Coffee Shop',
        details: null,
        debit: 50,
        credit: null,
        categoryId: 10,
        transaction_date: new Date('2026-01-15'),
        currency: 'USD',
        tags: [],
        ticker: null,
        assetQuantity: null,
        assetPrice: null,
      };
      const categoryById = makeCategoryMap();

      const diff = computeUpdateDiff(csvRow, existingTx, null, categoryById);

      expect(Object.keys(diff)).toHaveLength(0);
    });

    it('detects date changes at day level', () => {
      const csvRow = {
        description: 'Test',
        details: null,
        debit: '10',
        credit: null,
        date: '2026-01-20',
        currency: 'USD',
        tags: [],
        ticker: null,
        assetQuantity: null,
        assetPrice: null,
      };
      const existingTx = {
        description: 'Test',
        details: null,
        debit: 10,
        credit: null,
        categoryId: 10,
        transaction_date: new Date('2026-01-15'),
        currency: 'USD',
        tags: [],
        ticker: null,
        assetQuantity: null,
        assetPrice: null,
      };
      const categoryById = makeCategoryMap();

      const diff = computeUpdateDiff(csvRow, existingTx, null, categoryById);

      expect(diff.transactionDate).toBeDefined();
      expect(diff.transactionDate.old).toBe('2026-01-15');
      expect(diff.transactionDate.new).toBe('2026-01-20');
    });

    it('detects ticker changes', () => {
      const csvRow = {
        description: 'Buy stock',
        details: null,
        debit: '1000',
        credit: null,
        date: '2026-01-15',
        currency: 'USD',
        tags: [],
        ticker: 'AAPL',
        assetQuantity: null,
        assetPrice: null,
      };
      const existingTx = {
        description: 'Buy stock',
        details: null,
        debit: 1000,
        credit: null,
        categoryId: 10,
        transaction_date: new Date('2026-01-15'),
        currency: 'USD',
        tags: [],
        ticker: 'MSFT',
        assetQuantity: null,
        assetPrice: null,
      };
      const categoryById = makeCategoryMap();

      const diff = computeUpdateDiff(csvRow, existingTx, null, categoryById);

      expect(diff.ticker).toBeDefined();
      expect(diff.ticker.old).toBe('MSFT');
      expect(diff.ticker.new).toBe('AAPL');
    });
  });

  // ─── buildAiFrequencyMap ───────────────────────────────────────────────────

  describe('buildAiFrequencyMap', () => {
    it('groups entries by normalized description, highest frequency first', () => {
      const entries = [
        { description: 'Coffee Shop', amount: 5 },
        { description: 'coffee shop', amount: 3 },
        { description: 'COFFEE SHOP', amount: 7 },
        { description: 'Gas Station', amount: 40 },
        { description: 'gas station', amount: 35 },
      ];

      const map = buildAiFrequencyMap(entries);

      expect(map.size).toBe(2);
      expect(map.get('coffee shop')).toHaveLength(3);
      expect(map.get('gas station')).toHaveLength(2);
    });

    it('handles empty input', () => {
      const map = buildAiFrequencyMap([]);
      expect(map.size).toBe(0);
    });

    it('normalizes whitespace in descriptions', () => {
      const entries = [
        { description: '  Coffee  Shop  ' },
        { description: 'Coffee Shop' },
      ];

      const map = buildAiFrequencyMap(entries);

      // Both should map to same normalized key
      expect(map.size).toBe(1);
      expect(map.get('coffee shop')).toHaveLength(2);
    });

    it('handles null/empty descriptions gracefully', () => {
      const entries = [
        { description: null },
        { description: '' },
        { description: 'Valid' },
      ];

      const map = buildAiFrequencyMap(entries);

      // null and '' both normalize to ''
      expect(map.get('')).toHaveLength(2);
      expect(map.get('valid')).toHaveLength(1);
    });
  });

  // ─── applyDuplicateStatus ──────────────────────────────────────────────────

  describe('applyDuplicateStatus', () => {
    it('flags date-only duplicates as POTENTIAL_DUPLICATE and preserves them in the set', () => {
      const row = { status: 'PENDING' };
      const set = new Set(['hash-A']);

      const flagged = applyDuplicateStatus(row, set, 'hash-A', false);

      expect(flagged).toBe(true);
      expect(row.status).toBe('POTENTIAL_DUPLICATE');
      // The set is untouched when a collision is found — the existing hash stays
      expect(set.size).toBe(1);
    });

    it('flags timestamped duplicates as DUPLICATE (hard dup, hidden from UI by default)', () => {
      const row = { status: 'PENDING' };
      const set = new Set(['hash-B']);

      const flagged = applyDuplicateStatus(row, set, 'hash-B', true);

      expect(flagged).toBe(true);
      expect(row.status).toBe('DUPLICATE');
    });

    it('adds new hashes to the set and leaves status untouched', () => {
      const row = { status: 'PENDING' };
      const set = new Set(['hash-A']);

      const flagged = applyDuplicateStatus(row, set, 'hash-NEW', false);

      expect(flagged).toBe(false);
      expect(row.status).toBe('PENDING');
      expect(set.has('hash-NEW')).toBe(true);
    });

    it('flags the 2nd+ intra-CSV occurrence of the same hash', () => {
      const set = new Set();
      const row1 = { status: 'PENDING' };
      const row2 = { status: 'PENDING' };

      // First occurrence is tracked, not flagged.
      expect(applyDuplicateStatus(row1, set, 'hash-X', false)).toBe(false);
      expect(row1.status).toBe('PENDING');

      // Second occurrence of the same hash within the same CSV is flagged.
      expect(applyDuplicateStatus(row2, set, 'hash-X', false)).toBe(true);
      expect(row2.status).toBe('POTENTIAL_DUPLICATE');
    });
  });
});
