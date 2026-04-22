/**
 * Tests for the LLM provider factory (services/llm/index.js).
 *
 * Because the factory resolves adapters at module load, we use
 * jest.isolateModules to run each env-var scenario against a fresh
 * module graph.
 */

jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../../../config/classificationConfig', () => ({
  EMBEDDING_DIMENSIONS: 768,
}));

// Stub provider SDKs so adapter module loads succeed even without API keys.
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn(() => ({ getGenerativeModel: jest.fn() })),
}));

// The openai and anthropic adapters are stubs in Step 2; they don't require SDKs at module load.

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  // Ensure at least the Gemini key is present so its adapter initializes cleanly.
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  delete process.env.LLM_PROVIDER;
  delete process.env.EMBEDDING_PROVIDER;
}

describe('llm factory', () => {
  beforeEach(() => {
    resetEnv();
    jest.resetModules();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('defaults to gemini when no env vars are set', () => {
    jest.isolateModules(() => {
      const { resolveAdapters } = require('../../../../services/llm');
      const { primary, embedding } = resolveAdapters();
      expect(primary).toBe('gemini');
      expect(embedding).toBe('gemini');
    });
  });

  it('resolves LLM_PROVIDER=openai with default embedding=openai', () => {
    jest.isolateModules(() => {
      process.env.LLM_PROVIDER = 'openai';
      process.env.OPENAI_API_KEY = 'sk-test';
      const { resolveAdapters } = require('../../../../services/llm');
      const { primary, embedding } = resolveAdapters();
      expect(primary).toBe('openai');
      expect(embedding).toBe('openai');
    });
  });

  it('resolves LLM_PROVIDER=anthropic + EMBEDDING_PROVIDER=openai', () => {
    jest.isolateModules(() => {
      process.env.LLM_PROVIDER = 'anthropic';
      process.env.EMBEDDING_PROVIDER = 'openai';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      process.env.OPENAI_API_KEY = 'sk-test';
      const { resolveAdapters } = require('../../../../services/llm');
      const { primary, embedding } = resolveAdapters();
      expect(primary).toBe('anthropic');
      expect(embedding).toBe('openai');
    });
  });

  it('resolves LLM_PROVIDER=anthropic + EMBEDDING_PROVIDER=gemini', () => {
    jest.isolateModules(() => {
      process.env.LLM_PROVIDER = 'anthropic';
      process.env.EMBEDDING_PROVIDER = 'gemini';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      const { resolveAdapters } = require('../../../../services/llm');
      const { primary, embedding } = resolveAdapters();
      expect(primary).toBe('anthropic');
      expect(embedding).toBe('gemini');
    });
  });

  it('throws when LLM_PROVIDER=anthropic with no EMBEDDING_PROVIDER', () => {
    jest.isolateModules(() => {
      process.env.LLM_PROVIDER = 'anthropic';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      // Default embedding provider would be "anthropic" which must be rejected
      expect(() => require('../../../../services/llm')).toThrow(
        /EMBEDDING_PROVIDER=anthropic is not supported/
      );
    });
  });

  it('throws when EMBEDDING_PROVIDER=anthropic is explicitly set', () => {
    jest.isolateModules(() => {
      process.env.LLM_PROVIDER = 'gemini';
      process.env.EMBEDDING_PROVIDER = 'anthropic';
      expect(() => require('../../../../services/llm')).toThrow(
        /EMBEDDING_PROVIDER=anthropic is not supported/
      );
    });
  });

  it('throws on invalid LLM_PROVIDER value', () => {
    jest.isolateModules(() => {
      process.env.LLM_PROVIDER = 'mistral';
      expect(() => require('../../../../services/llm')).toThrow(
        /Invalid LLM_PROVIDER "mistral"/
      );
    });
  });

  it('throws on invalid EMBEDDING_PROVIDER value', () => {
    jest.isolateModules(() => {
      process.env.LLM_PROVIDER = 'gemini';
      process.env.EMBEDDING_PROVIDER = 'cohere';
      expect(() => require('../../../../services/llm')).toThrow(
        /Invalid EMBEDDING_PROVIDER "cohere"/
      );
    });
  });

  it('reuses the same adapter instance when primary === embedding', () => {
    jest.isolateModules(() => {
      const { resolveAdapters } = require('../../../../services/llm');
      const { primaryAdapter, embeddingAdapter } = resolveAdapters();
      expect(primaryAdapter).toBe(embeddingAdapter);
    });
  });

  it('uses distinct adapter instances when primary !== embedding', () => {
    jest.isolateModules(() => {
      process.env.LLM_PROVIDER = 'anthropic';
      process.env.EMBEDDING_PROVIDER = 'gemini';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      const { resolveAdapters } = require('../../../../services/llm');
      const { primaryAdapter, embeddingAdapter } = resolveAdapters();
      expect(primaryAdapter).not.toBe(embeddingAdapter);
    });
  });

  it('exports expected public API', () => {
    jest.isolateModules(() => {
      const api = require('../../../../services/llm');
      expect(typeof api.generateEmbedding).toBe('function');
      expect(typeof api.classifyTransaction).toBe('function');
      expect(typeof api.generateInsightContent).toBe('function');
      expect(typeof api.isRateLimitError).toBe('function');
      expect(Array.isArray(api.SUPPORTED_PROVIDERS)).toBe(true);
      expect(api.SUPPORTED_PROVIDERS).toEqual(['gemini', 'openai', 'anthropic']);
    });
  });
});
