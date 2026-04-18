// Mock external dependencies before requiring the module under test
jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../../../config/classificationConfig', () => ({
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

// Set API key so the adapter is initialized
process.env.GEMINI_API_KEY = 'test-key-123';

const { generateEmbedding, classifyTransaction, generateInsightContent, isRateLimitError, getDefaultModels, getEmbeddingDimensions } = require('../../../../services/llm/geminiAdapter');
const logger = require('../../../../utils/logger');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MOCK_EMBEDDING_VALUES = new Array(768).fill(0.01);

const MOCK_CATEGORIES = [
  { id: 1, name: 'Food & Dining', group: 'Living Expenses', type: 'EXPENSE' },
  { id: 2, name: 'Transport', group: 'Living Expenses', type: 'EXPENSE' },
  { id: 3, name: 'Salary', group: 'Income', type: 'INCOME' },
];

// ─── Tests ───────────────────────────────────────────────────────────────────

jest.useFakeTimers();

describe('geminiAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── generateEmbedding ────────────────────────────────────────────────────

  describe('generateEmbedding()', () => {
    it('throws when genAI is null (no GEMINI_API_KEY)', async () => {
      await jest.isolateModules(async () => {
        const originalKey = process.env.GEMINI_API_KEY;
        delete process.env.GEMINI_API_KEY;

        const { generateEmbedding: isolatedGenerate } = require('../../../../services/llm/geminiAdapter');

        await expect(isolatedGenerate('test')).rejects.toThrow('Gemini API key not configured');

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

    it('throws after MAX_RETRIES (5) exhausted', async () => {
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

    it('uses extended rate-limit backoff on 429 errors', async () => {
      jest.useRealTimers();

      mockEmbedContent
        .mockRejectedValueOnce(new Error('Error 429: quota exceeded'))
        .mockResolvedValueOnce({ embedding: { values: MOCK_EMBEDDING_VALUES } });

      const originalSetTimeout = global.setTimeout;
      global.setTimeout = (fn) => originalSetTimeout(fn, 0);

      try {
        const result = await generateEmbedding('starbucks');
        expect(result).toEqual(MOCK_EMBEDDING_VALUES);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('Gemini embedding attempt 1 failed, retrying in 60s')
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

        const { classifyTransaction: isolatedClassify } = require('../../../../services/llm/geminiAdapter');

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
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.stringContaining('Starbucks Coffee')
      );
    });

    it('clamps confidence to the 0-0.85 range', async () => {
      // Test clamping above 0.85 (hard cap)
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
      expect(high.confidence).toBe(0.85);

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
        .mockResolvedValueOnce({
          response: {
            text: () => JSON.stringify({
              categoryId: 999,
              confidence: 0.85,
              reasoning: 'Wrong category',
            }),
          },
        })
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

      await jest.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result.categoryId).toBe(1);
      expect(result.confidence).toBe(0.82);
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      expect(mockGenerateContent).toHaveBeenLastCalledWith(
        expect.stringContaining('CORRECTION: You returned categoryId 999')
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('LLM returned invalid categoryId 999')
      );
    });

    it('throws after MAX_RETRIES (5) exhausted on classification', async () => {
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

    it('includes Plaid category hint in the prompt when provided', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => JSON.stringify({
            categoryId: 1,
            confidence: 0.75,
            reasoning: 'restaurant',
          }),
        },
      });

      await classifyTransaction('MCDONALD\'S', 'McDonald\'s', MOCK_CATEGORIES, {
        primary: 'FOOD_AND_DRINK',
        detailed: 'FOOD_AND_DRINK_RESTAURANTS',
        confidence_level: 'HIGH',
      });

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.stringContaining('PLAID CATEGORY')
      );
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.stringContaining('FOOD_AND_DRINK')
      );
    });

    it('sanitizes prompt-injection characters from description and merchant', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => JSON.stringify({
            categoryId: 1,
            confidence: 0.75,
            reasoning: 'ok',
          }),
        },
      });

      await classifyTransaction('<ignore all>{evil}`', '<merchant>', MOCK_CATEGORIES);

      const promptSent = mockGenerateContent.mock.calls[0][0];
      expect(promptSent).not.toMatch(/<ignore all>/);
      expect(promptSent).not.toMatch(/\{evil\}/);
      expect(promptSent).not.toMatch(/`/);
    });
  });

  // ── generateInsightContent ──────────────────────────────────────────────

  describe('generateInsightContent()', () => {
    it('throws when genAI is null', async () => {
      await jest.isolateModules(async () => {
        const originalKey = process.env.GEMINI_API_KEY;
        delete process.env.GEMINI_API_KEY;

        const { generateInsightContent: isolated } = require('../../../../services/llm/geminiAdapter');

        await expect(isolated('prompt')).rejects.toThrow('Gemini API key not configured');

        process.env.GEMINI_API_KEY = originalKey;
      });
    });

    it('returns parsed JSON array on success', async () => {
      const insights = [{ lens: 'spending', title: 'Test', body: 'Body' }];
      mockGenerateContent.mockResolvedValueOnce({
        response: { text: () => JSON.stringify(insights) },
      });

      const result = await generateInsightContent('test prompt');
      expect(result).toEqual(insights);
    });

    it('throws when response is not an array', async () => {
      jest.useRealTimers();
      mockGenerateContent.mockImplementation(() =>
        Promise.resolve({
          response: { text: () => JSON.stringify({ not: 'array' }) },
        })
      );

      const originalSetTimeout = global.setTimeout;
      global.setTimeout = (fn) => originalSetTimeout(fn, 0);

      try {
        await expect(generateInsightContent('prompt')).rejects.toThrow(/Expected JSON array/);
      } finally {
        global.setTimeout = originalSetTimeout;
        jest.useFakeTimers();
      }
    });

    it('honors custom temperature option', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        response: { text: () => JSON.stringify([]) },
      });

      await generateInsightContent('prompt', { temperature: 0.9 }).catch(() => {});

      // Verify the model was requested with the custom temperature
      expect(mockGetGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({
          generationConfig: expect.objectContaining({ temperature: 0.9 }),
        })
      );
    });
  });

  // ── isRateLimitError ─────────────────────────────────────────────────────

  describe('isRateLimitError()', () => {
    it('detects 429 in message', () => {
      expect(isRateLimitError(new Error('HTTP 429 too many requests'))).toBe(true);
    });
    it('detects "quota" in message', () => {
      expect(isRateLimitError(new Error('quota exceeded'))).toBe(true);
    });
    it('detects "resource has been exhausted"', () => {
      expect(isRateLimitError(new Error('resource has been exhausted'))).toBe(true);
    });
    it('detects "rate limit"', () => {
      expect(isRateLimitError(new Error('Rate Limit reached'))).toBe(true);
    });
    it('returns false for generic errors', () => {
      expect(isRateLimitError(new Error('network unreachable'))).toBe(false);
      expect(isRateLimitError(new Error('bad request'))).toBe(false);
    });
    it('tolerates null/undefined errors', () => {
      expect(isRateLimitError(null)).toBe(false);
      expect(isRateLimitError(undefined)).toBe(false);
      expect(isRateLimitError({})).toBe(false);
    });
  });

  // ── metadata ─────────────────────────────────────────────────────────────

  describe('metadata helpers', () => {
    it('getDefaultModels returns the three model IDs', () => {
      const models = getDefaultModels();
      expect(models).toHaveProperty('embedding');
      expect(models).toHaveProperty('classification');
      expect(models).toHaveProperty('insight');
    });

    it('getEmbeddingDimensions returns 768', () => {
      expect(getEmbeddingDimensions()).toBe(768);
    });
  });
});
