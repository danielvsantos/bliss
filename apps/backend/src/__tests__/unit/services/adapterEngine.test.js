jest.mock('../../../utils/redis', () => ({
  getRedisConnection: jest.fn(),
}));

jest.mock('../../../../prisma/prisma', () => ({
  importAdapter: {
    findMany: jest.fn(),
  },
}));

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { getRedisConnection } = require('../../../utils/redis');
const prisma = require('../../../../prisma/prisma');

const {
  parseDate,
  parseDecimal,
  sortAdaptersBySpecificity,
  detectAdapter,
  parseFile,
} = require('../../../services/adapterEngine');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makeMockRedis = () => ({
  get: jest.fn().mockResolvedValue(null), // always cache miss
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('adapterEngine', () => {
  describe('parseDate()', () => {
    it('returns {date: null, hasTime: false} for null/falsy input', () => {
      const result = parseDate(null);
      expect(result.date).toBeNull();
      expect(result.hasTime).toBe(false);
    });

    it('parses YYYY-MM-DD correctly', () => {
      const { date, hasTime } = parseDate('2024-03-15');
      expect(date).toBeTruthy();
      expect(date.getUTCFullYear()).toBe(2024);
      expect(date.getUTCMonth()).toBe(2); // March = index 2
      expect(date.getUTCDate()).toBe(15);
      expect(hasTime).toBe(false);
    });

    it('parses DD/MM/YYYY when day > 12 unambiguously', () => {
      const { date } = parseDate('25/01/2024');
      expect(date).toBeTruthy();
      expect(date.getUTCDate()).toBe(25);
      expect(date.getUTCMonth()).toBe(0); // January
      expect(date.getUTCFullYear()).toBe(2024);
    });

    it('resolves a 2-digit year to the 21st century (2000 + year)', () => {
      const { date } = parseDate('15/06/24');
      expect(date).toBeTruthy();
      expect(date.getUTCFullYear()).toBe(2024);
      expect(date.getUTCDate()).toBe(15);
    });

    it('parses YYYY-MM-DD as UTC midnight (no timezone shift)', () => {
      const { date } = parseDate('2010-11-12');
      expect(date).toBeTruthy();
      expect(date.toISOString()).toBe('2010-11-12T00:00:00.000Z');
      expect(date.getUTCFullYear()).toBe(2010);
      expect(date.getUTCMonth()).toBe(10); // November = index 10
      expect(date.getUTCDate()).toBe(12);
    });

    it('parses DD/MM/YYYY as UTC midnight (no timezone shift)', () => {
      const { date } = parseDate('25/01/2024');
      expect(date).toBeTruthy();
      expect(date.toISOString()).toBe('2024-01-25T00:00:00.000Z');
      expect(date.getUTCDate()).toBe(25);
      expect(date.getUTCMonth()).toBe(0); // January
    });
  });

  describe('parseDecimal()', () => {
    it('parses a standard numeric string', () => {
      expect(parseDecimal('1234.56')).toBe(1234.56);
    });

    it('converts comma to period (European decimal separator)', () => {
      expect(parseDecimal('1234,56')).toBe(1234.56);
    });

    it('returns null for null, undefined, or empty string', () => {
      expect(parseDecimal(null)).toBeNull();
      expect(parseDecimal(undefined)).toBeNull();
      expect(parseDecimal('')).toBeNull();
    });
  });

  describe('sortAdaptersBySpecificity()', () => {
    it('places tenant-specific adapters before global (tenantId: null) adapters', () => {
      const adapters = [
        { tenantId: null, name: 'Global', matchSignature: { headers: ['date', 'amount'] } },
        { tenantId: 'tenant1', name: 'Custom', matchSignature: { headers: ['date'] } },
      ];
      const sorted = sortAdaptersBySpecificity(adapters);
      expect(sorted[0].name).toBe('Custom');
      expect(sorted[1].name).toBe('Global');
    });

    it('sorts by header count descending when tenantId is the same', () => {
      const adapters = [
        { tenantId: null, name: 'Few', matchSignature: { headers: ['date'] } },
        { tenantId: null, name: 'Many', matchSignature: { headers: ['date', 'amount', 'description'] } },
      ];
      const sorted = sortAdaptersBySpecificity(adapters);
      expect(sorted[0].name).toBe('Many');
      expect(sorted[1].name).toBe('Few');
    });
  });

  describe('detectAdapter()', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      getRedisConnection.mockReturnValue(makeMockRedis());
    });

    it('returns matched adapter when all required headers are present (case-insensitive)', async () => {
      prisma.importAdapter.findMany.mockResolvedValue([
        {
          id: 1,
          name: 'Test Bank',
          tenantId: null,
          isActive: true,
          matchSignature: { headers: ['Date', 'Amount', 'Description'] },
          columnMapping: { date: 'Date', amount: 'Amount', description: 'Description' },
          dateFormat: 'DD/MM/YYYY',
          amountStrategy: 'SINGLE_SIGNED',
          currencyDefault: 'USD',
          skipRows: 0,
        },
      ]);

      const result = await detectAdapter(
        ['date', 'amount', 'description', 'balance'], // 4 CSV headers, 3 matched
        [],
        'tenant1'
      );

      expect(result.matched).toBe(true);
      expect(result.adapter.name).toBe('Test Bank');
      expect(result.confidence).toBe(0.75); // 3 matched / 4 total = 0.75
    });

    it('returns matched:false when a required header is missing from the CSV', async () => {
      prisma.importAdapter.findMany.mockResolvedValue([
        {
          id: 2,
          name: 'Strict Adapter',
          tenantId: null,
          isActive: true,
          matchSignature: { headers: ['date', 'amount', 'account_number'] },
          columnMapping: {},
          dateFormat: null,
          amountStrategy: 'SINGLE_SIGNED',
          currencyDefault: null,
          skipRows: 0,
        },
      ]);

      const result = await detectAdapter(['date', 'amount'], [], 'tenant1');

      expect(result.matched).toBe(false);
    });
  });

  describe('parseFile() — tags column', () => {
    const makeAdapter = (columnMappingOverrides = {}) => ({
      name: 'Tags Test Adapter',
      columnMapping: {
        date: 'transactiondate',
        description: 'description',
        debit: 'debit',
        credit: 'credit',
        tags: 'tags',
        ...columnMappingOverrides,
      },
      dateFormat: 'YYYY-MM-DD',
      amountStrategy: 'DEBIT_CREDIT_COLUMNS',
      currencyDefault: 'USD',
      skipRows: 0,
    });

    it('parses comma-separated tags from CSV cell into string array', async () => {
      // Tags with commas must be quoted in CSV so PapaParse treats them as a single field
      const csv = 'transactiondate,description,debit,credit,tags\n2024-01-15,Flight,850,,"Japan 2026, Business"';
      const { rows } = await parseFile(csv, makeAdapter(), 'csv');
      expect(rows).toHaveLength(1);
      expect(rows[0].tags).toEqual(['Japan 2026', 'Business']);
    });

    it('returns null when tags column is missing from CSV', async () => {
      const csv = 'transactiondate,description,debit,credit\n2024-01-15,Flight,850,';
      const { rows } = await parseFile(csv, makeAdapter(), 'csv');
      expect(rows).toHaveLength(1);
      expect(rows[0].tags).toBeNull();
    });

    it('returns null for empty tags cell', async () => {
      const csv = 'transactiondate,description,debit,credit,tags\n2024-01-15,Flight,850,,';
      const { rows } = await parseFile(csv, makeAdapter(), 'csv');
      expect(rows).toHaveLength(1);
      expect(rows[0].tags).toBeNull();
    });

    it('handles single tag without comma', async () => {
      const csv = 'transactiondate,description,debit,credit,tags\n2024-01-15,Flight,850,,Vacation';
      const { rows } = await parseFile(csv, makeAdapter(), 'csv');
      expect(rows).toHaveLength(1);
      expect(rows[0].tags).toEqual(['Vacation']);
    });

    it('returns null when adapter has no tags in columnMapping', async () => {
      const adapterWithoutTags = makeAdapter({ tags: undefined });
      delete adapterWithoutTags.columnMapping.tags;
      const csv = 'transactiondate,description,debit,credit,tags\n2024-01-15,Flight,850,,Japan 2026';
      const { rows } = await parseFile(csv, adapterWithoutTags, 'csv');
      expect(rows).toHaveLength(1);
      expect(rows[0].tags).toBeNull();
    });
  });
});
