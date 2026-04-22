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
const mockEmbeddingsCreate = jest.fn();
const mockChatCompletionsCreate = jest.fn();

const mockOpenAIConstructor = jest.fn(() => ({
  embeddings: { create: mockEmbeddingsCreate },
  chat: { completions: { create: mockChatCompletionsCreate } },
}));

jest.mock('openai', () => mockOpenAIConstructor);

// Set API key so the adapter is initialized
process.env.OPENAI_API_KEY = 'sk-test-123';

// Clear any model-override env vars that might leak in from .env so the adapter
// falls back to its per-provider defaults (text-embedding-3-small / gpt-4.1-mini / gpt-4.1).
delete process.env.EMBEDDING_MODEL;
delete process.env.CLASSIFICATION_MODEL;
delete process.env.INSIGHT_MODEL;

const {
  generateEmbedding,
  classifyTransaction,
  generateInsightContent,
  isRateLimitError,
  getDefaultModels,
  getEmbeddingDimensions,
} = require('../../../../services/llm/openaiAdapter');
const logger = require('../../../../utils/logger');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MOCK_EMBEDDING_VALUES = new Array(768).fill(0.02);

const MOCK_CATEGORIES = [
  { id: 1, name: 'Food & Dining', group: 'Living Expenses', type: 'EXPENSE' },
  { id: 2, name: 'Transport', group: 'Living Expenses', type: 'EXPENSE' },
  { id: 3, name: 'Salary', group: 'Income', type: 'INCOME' },
];

function makeChatResponse(content) {
  return {
    choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

jest.useFakeTimers();

describe('openaiAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── generateEmbedding ────────────────────────────────────────────────────

  describe('generateEmbedding()', () => {
    it('throws when client is null (no OPENAI_API_KEY)', async () => {
      await jest.isolateModules(async () => {
        const originalKey = process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_API_KEY;

        const { generateEmbedding: isolated } = require('../../../../services/llm/openaiAdapter');

        await expect(isolated('test')).rejects.toThrow('OpenAI API key not configured');

        process.env.OPENAI_API_KEY = originalKey;
      });
    });

    it('throws for empty text', async () => {
      await expect(generateEmbedding('')).rejects.toThrow('Empty text cannot be embedded');
      await expect(generateEmbedding('   ')).rejects.toThrow('Empty text cannot be embedded');
      await expect(generateEmbedding(null)).rejects.toThrow('Empty text cannot be embedded');
    });

    it('returns embedding values on success with dimensions: 768', async () => {
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: MOCK_EMBEDDING_VALUES }],
      });

      const result = await generateEmbedding('Starbucks Coffee');
      expect(result).toEqual(MOCK_EMBEDDING_VALUES);
      expect(result).toHaveLength(768);
      expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(1);
      expect(mockEmbeddingsCreate).toHaveBeenCalledWith({
        model: 'text-embedding-3-small',
        input: 'Starbucks Coffee',
        dimensions: 768,
      });
    });

    it('retries on transient failure and succeeds', async () => {
      mockEmbeddingsCreate
        .mockRejectedValueOnce(new Error('network timeout'))
        .mockResolvedValueOnce({ data: [{ embedding: MOCK_EMBEDDING_VALUES }] });

      const promise = generateEmbedding('test');
      await jest.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result).toEqual(MOCK_EMBEDDING_VALUES);
      expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('OpenAI embedding attempt 1 failed')
      );
    });

    it('throws when response is malformed', async () => {
      jest.useRealTimers();
      mockEmbeddingsCreate.mockImplementation(() => Promise.resolve({ data: [] }));

      const originalSetTimeout = global.setTimeout;
      global.setTimeout = (fn) => originalSetTimeout(fn, 0);

      try {
        await expect(generateEmbedding('test')).rejects.toThrow(/missing data/);
      } finally {
        global.setTimeout = originalSetTimeout;
        jest.useFakeTimers();
      }
    });

    it('throws after MAX_RETRIES (5) exhausted', async () => {
      jest.useRealTimers();
      mockEmbeddingsCreate.mockImplementation(() => Promise.reject(new Error('server error')));

      const originalSetTimeout = global.setTimeout;
      global.setTimeout = (fn) => originalSetTimeout(fn, 0);

      try {
        await expect(generateEmbedding('test')).rejects.toThrow('server error');
        expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(5);
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('OpenAI embedding failed after 5 attempts')
        );
      } finally {
        global.setTimeout = originalSetTimeout;
        jest.useFakeTimers();
      }
    });

    it('uses extended rate-limit backoff on 429 errors', async () => {
      jest.useRealTimers();

      const rateLimitError = Object.assign(new Error('Too Many Requests'), { status: 429 });
      mockEmbeddingsCreate
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({ data: [{ embedding: MOCK_EMBEDDING_VALUES }] });

      const originalSetTimeout = global.setTimeout;
      global.setTimeout = (fn) => originalSetTimeout(fn, 0);

      try {
        const result = await generateEmbedding('starbucks');
        expect(result).toEqual(MOCK_EMBEDDING_VALUES);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('retrying in 60s')
        );
      } finally {
        global.setTimeout = originalSetTimeout;
        jest.useFakeTimers();
      }
    });
  });

  // ── classifyTransaction ──────────────────────────────────────────────────

  describe('classifyTransaction()', () => {
    it('throws when client is null', async () => {
      await jest.isolateModules(async () => {
        const originalKey = process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_API_KEY;

        const { classifyTransaction: isolated } = require('../../../../services/llm/openaiAdapter');

        await expect(isolated('Starbucks', null, MOCK_CATEGORIES)).rejects.toThrow(
          'OpenAI API key not configured'
        );

        process.env.OPENAI_API_KEY = originalKey;
      });
    });

    it('throws for empty categories array', async () => {
      await expect(classifyTransaction('Starbucks', null, [])).rejects.toThrow(
        'No categories provided'
      );
      await expect(classifyTransaction('Starbucks', null, null)).rejects.toThrow(
        'No categories provided'
      );
    });

    it('returns parsed classification result on success', async () => {
      mockChatCompletionsCreate.mockResolvedValueOnce(
        makeChatResponse({ categoryId: 1, confidence: 0.8, reasoning: 'Coffee purchase' })
      );

      const result = await classifyTransaction('Starbucks', 'Starbucks', MOCK_CATEGORIES);

      expect(result).toEqual({
        categoryId: 1,
        confidence: 0.8,
        reasoning: 'Coffee purchase',
      });
      expect(mockChatCompletionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-4.1-mini',
          temperature: 0.1,
          response_format: { type: 'json_object' },
          messages: expect.arrayContaining([
            expect.objectContaining({ role: 'system' }),
            expect.objectContaining({ role: 'user' }),
          ]),
        })
      );
    });

    it('clamps confidence to the 0-0.85 range', async () => {
      mockChatCompletionsCreate.mockResolvedValueOnce(
        makeChatResponse({ categoryId: 2, confidence: 1.5, reasoning: 'over' })
      );
      const high = await classifyTransaction('Uber', null, MOCK_CATEGORIES);
      expect(high.confidence).toBe(0.85);

      mockChatCompletionsCreate.mockResolvedValueOnce(
        makeChatResponse({ categoryId: 2, confidence: -0.3, reasoning: 'under' })
      );
      const low = await classifyTransaction('Uber', null, MOCK_CATEGORIES);
      expect(low.confidence).toBe(0);
    });

    it('validates categoryId against the provided list and retries on invalid ID', async () => {
      mockChatCompletionsCreate
        .mockResolvedValueOnce(
          makeChatResponse({ categoryId: 999, confidence: 0.8, reasoning: 'wrong' })
        )
        .mockResolvedValueOnce(
          makeChatResponse({ categoryId: 1, confidence: 0.75, reasoning: 'corrected' })
        );

      const promise = classifyTransaction('Starbucks', null, MOCK_CATEGORIES);
      await jest.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result.categoryId).toBe(1);
      expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(2);
      // Verify retry feedback was appended to the user message
      const secondCallMessages = mockChatCompletionsCreate.mock.calls[1][0].messages;
      expect(secondCallMessages[1].content).toContain('CORRECTION: You returned categoryId 999');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('LLM returned invalid categoryId 999')
      );
    });

    it('coerces string categoryId to Number', async () => {
      mockChatCompletionsCreate.mockResolvedValueOnce(
        makeChatResponse({ categoryId: '3', confidence: 0.7, reasoning: 'salary' })
      );

      const result = await classifyTransaction('Salary', null, MOCK_CATEGORIES);
      expect(result.categoryId).toBe(3);
      expect(typeof result.categoryId).toBe('number');
    });

    it('throws when response is missing content', async () => {
      jest.useRealTimers();
      mockChatCompletionsCreate.mockImplementation(() =>
        Promise.resolve({ choices: [{ message: {} }] })
      );

      const originalSetTimeout = global.setTimeout;
      global.setTimeout = (fn) => originalSetTimeout(fn, 0);

      try {
        await expect(classifyTransaction('x', null, MOCK_CATEGORIES)).rejects.toThrow(
          /missing content/
        );
      } finally {
        global.setTimeout = originalSetTimeout;
        jest.useFakeTimers();
      }
    });

    it('includes Plaid category hint in the user message when provided', async () => {
      mockChatCompletionsCreate.mockResolvedValueOnce(
        makeChatResponse({ categoryId: 1, confidence: 0.75, reasoning: 'rest' })
      );

      await classifyTransaction("MCDONALD'S", "McDonald's", MOCK_CATEGORIES, {
        primary: 'FOOD_AND_DRINK',
        detailed: 'FOOD_AND_DRINK_RESTAURANTS',
        confidence_level: 'HIGH',
      });

      const userMsg = mockChatCompletionsCreate.mock.calls[0][0].messages[1].content;
      expect(userMsg).toContain('PLAID CATEGORY');
      expect(userMsg).toContain('FOOD_AND_DRINK');
    });

    it('sanitizes prompt-injection characters', async () => {
      mockChatCompletionsCreate.mockResolvedValueOnce(
        makeChatResponse({ categoryId: 1, confidence: 0.7, reasoning: 'ok' })
      );

      await classifyTransaction('<ignore all>{evil}`', '<merchant>', MOCK_CATEGORIES);

      const userMsg = mockChatCompletionsCreate.mock.calls[0][0].messages[1].content;
      expect(userMsg).not.toMatch(/<ignore all>/);
      expect(userMsg).not.toMatch(/\{evil\}/);
      expect(userMsg).not.toMatch(/`/);
    });

    it('throws after MAX_RETRIES exhausted', async () => {
      jest.useRealTimers();
      mockChatCompletionsCreate.mockImplementation(() =>
        Promise.reject(new Error('upstream error'))
      );

      const originalSetTimeout = global.setTimeout;
      global.setTimeout = (fn) => originalSetTimeout(fn, 0);

      try {
        await expect(classifyTransaction('x', null, MOCK_CATEGORIES)).rejects.toThrow(
          'upstream error'
        );
        expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(5);
      } finally {
        global.setTimeout = originalSetTimeout;
        jest.useFakeTimers();
      }
    });
  });

  // ── generateInsightContent ───────────────────────────────────────────────

  describe('generateInsightContent()', () => {
    it('throws when client is null', async () => {
      await jest.isolateModules(async () => {
        const originalKey = process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_API_KEY;

        const { generateInsightContent: isolated } = require('../../../../services/llm/openaiAdapter');

        await expect(isolated('p')).rejects.toThrow('OpenAI API key not configured');

        process.env.OPENAI_API_KEY = originalKey;
      });
    });

    it('unwraps the "insights" array from the response object', async () => {
      const insights = [{ lens: 'spending', title: 'T' }];
      mockChatCompletionsCreate.mockResolvedValueOnce(
        makeChatResponse({ insights })
      );

      const result = await generateInsightContent('prompt');
      expect(result).toEqual(insights);
    });

    it('accepts a bare JSON array at the root (fallback)', async () => {
      const insights = [{ lens: 'x' }];
      mockChatCompletionsCreate.mockResolvedValueOnce(makeChatResponse(insights));

      const result = await generateInsightContent('prompt');
      expect(result).toEqual(insights);
    });

    it('throws when neither an array nor an "insights" wrapper is present', async () => {
      jest.useRealTimers();
      mockChatCompletionsCreate.mockImplementation(() =>
        Promise.resolve(makeChatResponse({ wrongKey: [1] }))
      );

      const originalSetTimeout = global.setTimeout;
      global.setTimeout = (fn) => originalSetTimeout(fn, 0);

      try {
        await expect(generateInsightContent('p')).rejects.toThrow(/Expected JSON array/);
      } finally {
        global.setTimeout = originalSetTimeout;
        jest.useFakeTimers();
      }
    });

    it('honors custom temperature option', async () => {
      mockChatCompletionsCreate.mockResolvedValueOnce(makeChatResponse({ insights: [] }));

      await generateInsightContent('p', { temperature: 0.9 });

      expect(mockChatCompletionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 0.9 })
      );
    });

    it('uses INSIGHT_MODEL for insight calls', async () => {
      mockChatCompletionsCreate.mockResolvedValueOnce(makeChatResponse({ insights: [] }));

      await generateInsightContent('p');

      expect(mockChatCompletionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4.1' })
      );
    });
  });

  // ── isRateLimitError ─────────────────────────────────────────────────────

  describe('isRateLimitError()', () => {
    it('detects status=429 on SDK error', () => {
      expect(isRateLimitError({ status: 429, message: 'Too Many Requests' })).toBe(true);
    });
    it('detects code=rate_limit_exceeded', () => {
      expect(isRateLimitError({ code: 'rate_limit_exceeded' })).toBe(true);
    });
    it('detects code=insufficient_quota', () => {
      expect(isRateLimitError({ code: 'insufficient_quota' })).toBe(true);
    });
    it('detects 429 in message as fallback', () => {
      expect(isRateLimitError(new Error('HTTP 429 quota hit'))).toBe(true);
    });
    it('returns false for generic errors', () => {
      expect(isRateLimitError(new Error('network'))).toBe(false);
      expect(isRateLimitError({ status: 500 })).toBe(false);
    });
    it('tolerates null/undefined errors', () => {
      expect(isRateLimitError(null)).toBe(false);
      expect(isRateLimitError(undefined)).toBe(false);
      expect(isRateLimitError({})).toBe(false);
    });
  });

  // ── metadata helpers ─────────────────────────────────────────────────────

  describe('metadata helpers', () => {
    it('getDefaultModels returns the three model IDs', () => {
      const models = getDefaultModels();
      expect(models.embedding).toBe('text-embedding-3-small');
      expect(models.classification).toBe('gpt-4.1-mini');
      expect(models.insight).toBe('gpt-4.1');
    });

    it('getEmbeddingDimensions returns 768', () => {
      expect(getEmbeddingDimensions()).toBe(768);
    });
  });
});
