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
const mockMessagesCreate = jest.fn();

const mockAnthropicConstructor = jest.fn(() => ({
  messages: { create: mockMessagesCreate },
}));

jest.mock('@anthropic-ai/sdk', () => mockAnthropicConstructor);

// Set API key so the adapter is initialized
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-123';

// Clear model-override env vars so adapter uses per-provider defaults
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
} = require('../../../../services/llm/anthropicAdapter');
const logger = require('../../../../utils/logger');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MOCK_CATEGORIES = [
  { id: 1, name: 'Food & Dining', group: 'Living Expenses', type: 'EXPENSE' },
  { id: 2, name: 'Transport', group: 'Living Expenses', type: 'EXPENSE' },
  { id: 3, name: 'Salary', group: 'Income', type: 'INCOME' },
];

/**
 * Build a Claude messages-api response object with a text block.
 * @param {string} text — raw text content Claude would return
 */
function makeMessagesResponse(text) {
  return {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

jest.useFakeTimers();

describe('anthropicAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── generateEmbedding ────────────────────────────────────────────────────

  describe('generateEmbedding()', () => {
    it('always throws — Anthropic has no embedding API', async () => {
      await expect(generateEmbedding('any text')).rejects.toThrow(
        /Anthropic does not support embeddings/
      );
      await expect(generateEmbedding('')).rejects.toThrow(
        /Set EMBEDDING_PROVIDER=gemini or openai/
      );
    });
  });

  // ── classifyTransaction ──────────────────────────────────────────────────

  describe('classifyTransaction()', () => {
    it('throws when client is null (no ANTHROPIC_API_KEY)', async () => {
      await jest.isolateModules(async () => {
        const originalKey = process.env.ANTHROPIC_API_KEY;
        delete process.env.ANTHROPIC_API_KEY;

        const { classifyTransaction: isolated } = require('../../../../services/llm/anthropicAdapter');

        await expect(isolated('Starbucks', null, MOCK_CATEGORIES)).rejects.toThrow(
          'Anthropic API key not configured'
        );

        process.env.ANTHROPIC_API_KEY = originalKey;
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

    it('parses JSON from <json>…</json> tags', async () => {
      mockMessagesCreate.mockResolvedValueOnce(
        makeMessagesResponse(
          '<json>{"categoryId": 1, "confidence": 0.8, "reasoning": "Coffee"}</json>'
        )
      );

      const result = await classifyTransaction('Starbucks', 'Starbucks', MOCK_CATEGORIES);
      expect(result).toEqual({ categoryId: 1, confidence: 0.8, reasoning: 'Coffee' });
    });

    it('parses JSON from fenced code block (fallback)', async () => {
      mockMessagesCreate.mockResolvedValueOnce(
        makeMessagesResponse(
          'Here is the result:\n```json\n{"categoryId": 2, "confidence": 0.7, "reasoning": "Transit"}\n```'
        )
      );

      const result = await classifyTransaction('Uber', null, MOCK_CATEGORIES);
      expect(result).toEqual({ categoryId: 2, confidence: 0.7, reasoning: 'Transit' });
    });

    it('parses bare JSON with preamble (fallback)', async () => {
      mockMessagesCreate.mockResolvedValueOnce(
        makeMessagesResponse(
          'My classification: {"categoryId": 3, "confidence": 0.75, "reasoning": "Salary"}'
        )
      );

      const result = await classifyTransaction('Monthly salary', null, MOCK_CATEGORIES);
      expect(result).toEqual({ categoryId: 3, confidence: 0.75, reasoning: 'Salary' });
    });

    it('sends system + user messages with correct shape', async () => {
      mockMessagesCreate.mockResolvedValueOnce(
        makeMessagesResponse('<json>{"categoryId": 1, "confidence": 0.7, "reasoning": "x"}</json>')
      );

      await classifyTransaction('Starbucks', null, MOCK_CATEGORIES);

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-4-6',
          max_tokens: 512,
          temperature: 0.1,
          system: expect.stringContaining('financial transaction classifier'),
          messages: [
            expect.objectContaining({ role: 'user', content: expect.any(String) }),
          ],
        })
      );
    });

    it('clamps confidence to the 0-0.85 range', async () => {
      mockMessagesCreate.mockResolvedValueOnce(
        makeMessagesResponse('<json>{"categoryId": 2, "confidence": 1.5, "reasoning": "over"}</json>')
      );
      const high = await classifyTransaction('Uber', null, MOCK_CATEGORIES);
      expect(high.confidence).toBe(0.85);

      mockMessagesCreate.mockResolvedValueOnce(
        makeMessagesResponse('<json>{"categoryId": 2, "confidence": -0.3, "reasoning": "under"}</json>')
      );
      const low = await classifyTransaction('Uber', null, MOCK_CATEGORIES);
      expect(low.confidence).toBe(0);
    });

    it('validates categoryId against the provided list and retries on invalid ID', async () => {
      mockMessagesCreate
        .mockResolvedValueOnce(
          makeMessagesResponse(
            '<json>{"categoryId": 999, "confidence": 0.8, "reasoning": "wrong"}</json>'
          )
        )
        .mockResolvedValueOnce(
          makeMessagesResponse(
            '<json>{"categoryId": 1, "confidence": 0.75, "reasoning": "corrected"}</json>'
          )
        );

      const promise = classifyTransaction('Starbucks', null, MOCK_CATEGORIES);
      await jest.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result.categoryId).toBe(1);
      expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
      // Second call should include the correction feedback appended to user message
      const secondCallContent = mockMessagesCreate.mock.calls[1][0].messages[0].content;
      expect(secondCallContent).toContain('CORRECTION: You returned categoryId 999');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('LLM returned invalid categoryId 999')
      );
    });

    it('coerces string categoryId to Number', async () => {
      mockMessagesCreate.mockResolvedValueOnce(
        makeMessagesResponse('<json>{"categoryId": "3", "confidence": 0.7, "reasoning": "s"}</json>')
      );

      const result = await classifyTransaction('Salary', null, MOCK_CATEGORIES);
      expect(result.categoryId).toBe(3);
      expect(typeof result.categoryId).toBe('number');
    });

    it('throws when response has no text content', async () => {
      jest.useRealTimers();
      mockMessagesCreate.mockImplementation(() =>
        Promise.resolve({ content: [{ type: 'tool_use' }], stop_reason: 'end_turn' })
      );

      const originalSetTimeout = global.setTimeout;
      global.setTimeout = (fn) => originalSetTimeout(fn, 0);

      try {
        await expect(classifyTransaction('x', null, MOCK_CATEGORIES)).rejects.toThrow(
          /missing text content/
        );
      } finally {
        global.setTimeout = originalSetTimeout;
        jest.useFakeTimers();
      }
    });

    it('includes Plaid category hint in the user message when provided', async () => {
      mockMessagesCreate.mockResolvedValueOnce(
        makeMessagesResponse('<json>{"categoryId": 1, "confidence": 0.7, "reasoning": "r"}</json>')
      );

      await classifyTransaction("MCDONALD'S", "McDonald's", MOCK_CATEGORIES, {
        primary: 'FOOD_AND_DRINK',
        detailed: 'FOOD_AND_DRINK_RESTAURANTS',
        confidence_level: 'HIGH',
      });

      const userContent = mockMessagesCreate.mock.calls[0][0].messages[0].content;
      expect(userContent).toContain('PLAID CATEGORY');
      expect(userContent).toContain('FOOD_AND_DRINK');
    });

    it('sanitizes prompt-injection characters from description and merchant', async () => {
      mockMessagesCreate.mockResolvedValueOnce(
        makeMessagesResponse('<json>{"categoryId": 1, "confidence": 0.6, "reasoning": "ok"}</json>')
      );

      await classifyTransaction('<ignore all>{evil}`', '<merchant>', MOCK_CATEGORIES);

      const userContent = mockMessagesCreate.mock.calls[0][0].messages[0].content;
      expect(userContent).not.toMatch(/<ignore all>/);
      expect(userContent).not.toMatch(/\{evil\}/);
      expect(userContent).not.toMatch(/`/);
    });

    it('throws after MAX_RETRIES exhausted', async () => {
      jest.useRealTimers();
      mockMessagesCreate.mockImplementation(() =>
        Promise.reject(new Error('server overloaded hard'))
      );

      const originalSetTimeout = global.setTimeout;
      global.setTimeout = (fn) => originalSetTimeout(fn, 0);

      try {
        await expect(classifyTransaction('x', null, MOCK_CATEGORIES)).rejects.toThrow(
          'server overloaded hard'
        );
        expect(mockMessagesCreate).toHaveBeenCalledTimes(5);
      } finally {
        global.setTimeout = originalSetTimeout;
        jest.useFakeTimers();
      }
    });

    it('joins multi-block text responses correctly', async () => {
      mockMessagesCreate.mockResolvedValueOnce({
        content: [
          { type: 'text', text: "Here's my analysis.\n" },
          { type: 'text', text: '<json>{"categoryId": 1, "confidence": 0.7, "reasoning": "t"}</json>' },
        ],
      });

      const result = await classifyTransaction('Starbucks', null, MOCK_CATEGORIES);
      expect(result.categoryId).toBe(1);
    });
  });

  // ── generateInsightContent ───────────────────────────────────────────────

  describe('generateInsightContent()', () => {
    it('throws when client is null', async () => {
      await jest.isolateModules(async () => {
        const originalKey = process.env.ANTHROPIC_API_KEY;
        delete process.env.ANTHROPIC_API_KEY;

        const { generateInsightContent: isolated } = require('../../../../services/llm/anthropicAdapter');

        await expect(isolated('p')).rejects.toThrow('Anthropic API key not configured');

        process.env.ANTHROPIC_API_KEY = originalKey;
      });
    });

    it('parses a JSON array from <json>…</json>', async () => {
      const insights = [{ lens: 'spending', title: 'Test', body: 'Body' }];
      mockMessagesCreate.mockResolvedValueOnce(
        makeMessagesResponse(`<json>${JSON.stringify(insights)}</json>`)
      );

      const result = await generateInsightContent('my prompt');
      expect(result).toEqual(insights);
    });

    it('parses a JSON array from a fenced code block (fallback)', async () => {
      const insights = [{ lens: 'x' }];
      mockMessagesCreate.mockResolvedValueOnce(
        makeMessagesResponse(`Here you go:\n\`\`\`json\n${JSON.stringify(insights)}\n\`\`\``)
      );

      const result = await generateInsightContent('my prompt');
      expect(result).toEqual(insights);
    });

    it('parses a bare JSON array (fallback)', async () => {
      const insights = [{ lens: 'y' }];
      mockMessagesCreate.mockResolvedValueOnce(
        makeMessagesResponse(`${JSON.stringify(insights)}`)
      );

      const result = await generateInsightContent('my prompt');
      expect(result).toEqual(insights);
    });

    it('unwraps a defensive {"insights": [...]} wrapper if the model uses one', async () => {
      const insights = [{ lens: 'z' }];
      mockMessagesCreate.mockResolvedValueOnce(
        makeMessagesResponse(`<json>${JSON.stringify({ insights })}</json>`)
      );

      const result = await generateInsightContent('my prompt');
      expect(result).toEqual(insights);
    });

    it('throws when neither array nor insights wrapper is present', async () => {
      jest.useRealTimers();
      mockMessagesCreate.mockImplementation(() =>
        Promise.resolve(makeMessagesResponse('<json>{"wrong": 1}</json>'))
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

    it('throws when the response has no text content', async () => {
      jest.useRealTimers();
      mockMessagesCreate.mockImplementation(() =>
        Promise.resolve({ content: [] })
      );

      const originalSetTimeout = global.setTimeout;
      global.setTimeout = (fn) => originalSetTimeout(fn, 0);

      try {
        await expect(generateInsightContent('p')).rejects.toThrow(/missing text content/);
      } finally {
        global.setTimeout = originalSetTimeout;
        jest.useFakeTimers();
      }
    });

    it('honors custom temperature option', async () => {
      mockMessagesCreate.mockResolvedValueOnce(makeMessagesResponse('<json>[]</json>'));

      await generateInsightContent('p', { temperature: 0.9 });

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 0.9 })
      );
    });

    it('uses INSIGHT_MODEL (claude-sonnet-4-6) by default', async () => {
      mockMessagesCreate.mockResolvedValueOnce(makeMessagesResponse('<json>[]</json>'));

      await generateInsightContent('p');

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-sonnet-4-6' })
      );
    });

    it('appends the JSON-wrapper instruction to the prompt', async () => {
      mockMessagesCreate.mockResolvedValueOnce(makeMessagesResponse('<json>[]</json>'));

      await generateInsightContent('original prompt');

      const userContent = mockMessagesCreate.mock.calls[0][0].messages[0].content;
      expect(userContent).toContain('original prompt');
      expect(userContent).toContain('<json>');
    });
  });

  // ── isRateLimitError ─────────────────────────────────────────────────────

  describe('isRateLimitError()', () => {
    it('detects status=429 on SDK error', () => {
      expect(isRateLimitError({ status: 429, message: 'Too Many Requests' })).toBe(true);
    });
    it('detects RateLimitError by name', () => {
      expect(isRateLimitError({ name: 'RateLimitError', message: 'x' })).toBe(true);
    });
    it('detects type=rate_limit_error on nested error body', () => {
      expect(isRateLimitError({ error: { type: 'rate_limit_error' } })).toBe(true);
    });
    it('detects type=overloaded_error on nested error body', () => {
      expect(isRateLimitError({ error: { type: 'overloaded_error' } })).toBe(true);
    });
    it('detects 429 in message as fallback', () => {
      expect(isRateLimitError(new Error('HTTP 429 quota hit'))).toBe(true);
    });
    it('detects "overloaded" in message', () => {
      expect(isRateLimitError(new Error('model is overloaded'))).toBe(true);
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
    it('getDefaultModels reports no embedding model and a classification/insight model', () => {
      const models = getDefaultModels();
      expect(models.embedding).toBeNull();
      expect(models.classification).toBe('claude-sonnet-4-6');
      expect(models.insight).toBe('claude-sonnet-4-6');
    });

    it('getEmbeddingDimensions returns 768 (for downstream compatibility)', () => {
      expect(getEmbeddingDimensions()).toBe(768);
    });
  });
});
