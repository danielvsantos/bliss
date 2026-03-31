// Mock external dependencies before requiring the module under test
jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../../config/classificationConfig', () => ({
  EMBEDDING_DIMENSIONS: 768,
}));

// ─── Shared mock references ─────────────────────────────────────────────────
const mockEmbedContent = jest.fn();
const mockGenerateContent = jest.fn();
const mockGetGenerativeModel = jest.fn((opts) => {
  if (opts.model === 'gemini-embedding-001') {
    return { embedContent: mockEmbedContent };
  }
  return { generateContent: mockGenerateContent };
});
const mockGoogleGenerativeAI = jest.fn(() => ({
  getGenerativeModel: mockGetGenerativeModel,
}));

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: mockGoogleGenerativeAI,
}));

// Set API key so genAI is initialized
process.env.GEMINI_API_KEY = 'test-key-123';

const { generateEmbedding, classifyTransaction } = require('../../../services/geminiService');
const logger = require('../../../utils/logger');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MOCK_EMBEDDING_VALUES = new Array(768).fill(0.01);

const MOCK_CATEGORIES = [
  { id: 1, name: 'Food & Dining', group: 'Living Expenses', type: 'EXPENSE' },
  { id: 2, name: 'Transport', group: 'Living Expenses', type: 'EXPENSE' },
  { id: 3, name: 'Salary', group: 'Income', type: 'INCOME' },
];

// ─── Tests ───────────────────────────────────────────────────────────────────

jest.useFakeTimers();

describe('geminiService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── generateEmbedding ────────────────────────────────────────────────────

  describe('generateEmbedding()', () => {
    it('throws when genAI is null (no GEMINI_API_KEY)', async () => {
      // Use isolateModules to load the module without the API key
      await jest.isolateModules(async () => {
        const originalKey = process.env.GEMINI_API_KEY;
        delete process.env.GEMINI_API_KEY;

        const { generateEmbedding: isolatedGenerate } = require('../../../services/geminiService');

        await expect(isolatedGenerate('test')).rejects.toThrow('Gemini API key not configured');

        // Restore for subsequent tests
        process.env.GEMINI_API_KEY = originalKey;
      });
    });

    it('throws for empty text', async () => {
      await expect(generateEmbedding('')).rejects.toThrow('Empty text cannot be embedded');
      await expect(generateEmbedding('   ')).rejects.toThrow('Empty text cannot be embedded');
      await expect(generateEmbedding(null)).rejects.toThrow('Empty text cannot be embedded');
    });

    it('returns embedding values on success', async () => {
      mockEmbedContent.mockResolvedValueOnce({
        embedding: { values: MOCK_EMBEDDING_VALUES },
      });

      const result = await generateEmbedding('Starbucks Coffee');
      expect(result).toEqual(MOCK_EMBEDDING_VALUES);
      expect(result).toHaveLength(768);
      expect(mockEmbedContent).toHaveBeenCalledTimes(1);
      expect(mockEmbedContent).toHaveBeenCalledWith({
        content: { parts: [{ text: 'Starbucks Coffee' }] },
        outputDimensionality: 768,
      });
    });

    it('retries on transient failure and succeeds', async () => {
      mockEmbedContent
        .mockRejectedValueOnce(new Error('server error'))
        .mockResolvedValueOnce({ embedding: { values: MOCK_EMBEDDING_VALUES } });

      const promise = generateEmbedding('test description');

      // Advance past the first retry delay (BASE_DELAY_MS * 2^0 = 1000ms)
      await jest.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result).toEqual(MOCK_EMBEDDING_VALUES);
      expect(mockEmbedContent).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Gemini embedding attempt 1 failed')
      );
    });

    it('throws after MAX_RETRIES (3) exhausted', async () => {
      jest.useRealTimers();

      mockEmbedContent.mockImplementation(() =>
        Promise.reject(new Error('service unavailable'))
      );

      // Override sleep delay: monkey-patch setTimeout to fire immediately
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = (fn) => originalSetTimeout(fn, 0);

      try {
        await expect(generateEmbedding('test description')).rejects.toThrow('service unavailable');
        expect(mockEmbedContent).toHaveBeenCalledTimes(5);
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('Gemini embedding failed after 5 attempts')
        );
      } finally {
        global.setTimeout = originalSetTimeout;
        jest.useFakeTimers();
      }
    });
  });

  // ── classifyTransaction ──────────────────────────────────────────────────

  describe('classifyTransaction()', () => {
    it('throws when genAI is null (no GEMINI_API_KEY)', async () => {
      await jest.isolateModules(async () => {
        const originalKey = process.env.GEMINI_API_KEY;
        delete process.env.GEMINI_API_KEY;

        const { classifyTransaction: isolatedClassify } = require('../../../services/geminiService');

        await expect(
          isolatedClassify('Starbucks', null, MOCK_CATEGORIES)
        ).rejects.toThrow('Gemini API key not configured');

        process.env.GEMINI_API_KEY = originalKey;
      });
    });

    it('throws for empty categories array', async () => {
      await expect(
        classifyTransaction('Starbucks', null, [])
      ).rejects.toThrow('No categories provided');

      await expect(
        classifyTransaction('Starbucks', null, null)
      ).rejects.toThrow('No categories provided');
    });

    it('returns parsed classification result on success', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => JSON.stringify({
            categoryId: 1,
            confidence: 0.80,
            reasoning: 'Looks like a coffee purchase',
          }),
        },
      });

      const result = await classifyTransaction('Starbucks Coffee', 'Starbucks', MOCK_CATEGORIES);

      expect(result).toEqual({
        categoryId: 1,
        confidence: 0.80,
        reasoning: 'Looks like a coffee purchase',
      });
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      // Verify the prompt contains the transaction description
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.stringContaining('Starbucks Coffee')
      );
    });

    it('clamps confidence to the 0-1 range', async () => {
      // Test clamping above 1
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => JSON.stringify({
            categoryId: 2,
            confidence: 1.5,
            reasoning: 'Over-confident',
          }),
        },
      });

      const high = await classifyTransaction('Uber Ride', null, MOCK_CATEGORIES);
      expect(high.confidence).toBe(0.85); // Hard-capped at 0.85 — LLM can never auto-promote

      // Test clamping below 0
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => JSON.stringify({
            categoryId: 2,
            confidence: -0.3,
            reasoning: 'Under-confident',
          }),
        },
      });

      const low = await classifyTransaction('Uber Ride', null, MOCK_CATEGORIES);
      expect(low.confidence).toBe(0);
    });

    it('validates categoryId against the provided categories list and retries on invalid ID', async () => {
      mockGenerateContent
        // First attempt: return invalid categoryId (999 not in list)
        .mockResolvedValueOnce({
          response: {
            text: () => JSON.stringify({
              categoryId: 999,
              confidence: 0.85,
              reasoning: 'Wrong category',
            }),
          },
        })
        // Second attempt: return valid categoryId
        .mockResolvedValueOnce({
          response: {
            text: () => JSON.stringify({
              categoryId: 1,
              confidence: 0.82,
              reasoning: 'Corrected to food',
            }),
          },
        });

      const promise = classifyTransaction('Starbucks', null, MOCK_CATEGORIES);

      // Advance past the first retry delay (1000ms)
      await jest.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result.categoryId).toBe(1);
      expect(result.confidence).toBe(0.82);
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      // Verify retry feedback was appended to the prompt
      expect(mockGenerateContent).toHaveBeenLastCalledWith(
        expect.stringContaining('CORRECTION: You returned categoryId 999')
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('LLM returned invalid categoryId 999')
      );
    });

    it('throws after MAX_RETRIES (3) exhausted on classification', async () => {
      jest.useRealTimers();

      mockGenerateContent.mockImplementation(() =>
        Promise.reject(new Error('model overloaded'))
      );

      const originalSetTimeout = global.setTimeout;
      global.setTimeout = (fn) => originalSetTimeout(fn, 0);

      try {
        await expect(
          classifyTransaction('Unknown Store', null, MOCK_CATEGORIES)
        ).rejects.toThrow('model overloaded');
        expect(mockGenerateContent).toHaveBeenCalledTimes(5);
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('Gemini classification failed after 5 attempts')
        );
      } finally {
        global.setTimeout = originalSetTimeout;
        jest.useFakeTimers();
      }
    });

    it('coerces string categoryId to Number', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => JSON.stringify({
            categoryId: '3',
            confidence: 0.91,
            reasoning: 'Salary deposit',
          }),
        },
      });

      const result = await classifyTransaction('Monthly Salary', null, MOCK_CATEGORIES);
      expect(result.categoryId).toBe(3);
      expect(typeof result.categoryId).toBe('number');
    });
  });
});
