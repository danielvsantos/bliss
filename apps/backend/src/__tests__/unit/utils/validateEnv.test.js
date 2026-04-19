jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { validateLlmConfig } = require('../../../utils/validateEnv');

const PROVIDER_ENV_KEYS = [
  'LLM_PROVIDER',
  'EMBEDDING_PROVIDER',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
];

function clearLlmEnv() {
  for (const k of PROVIDER_ENV_KEYS) delete process.env[k];
}

function runValidator() {
  const errors = [];
  const warnings = [];
  validateLlmConfig({ errors, warnings });
  return { errors, warnings };
}

describe('validateLlmConfig', () => {
  beforeEach(() => {
    clearLlmEnv();
  });

  describe('primary provider resolution', () => {
    it('defaults to gemini when LLM_PROVIDER is unset', () => {
      const { errors, warnings } = runValidator();
      expect(errors).toEqual([]);
      expect(warnings.some((w) => w.includes('GEMINI_API_KEY not set'))).toBe(true);
    });

    it('accepts LLM_PROVIDER=openai with matching key', () => {
      process.env.LLM_PROVIDER = 'openai';
      process.env.OPENAI_API_KEY = 'sk-test';
      const { errors, warnings } = runValidator();
      expect(errors).toEqual([]);
      expect(warnings).toEqual([]);
    });

    it('accepts LLM_PROVIDER=openai case-insensitively', () => {
      process.env.LLM_PROVIDER = 'OpenAI';
      process.env.OPENAI_API_KEY = 'sk-test';
      const { errors } = runValidator();
      expect(errors).toEqual([]);
    });

    it('rejects invalid LLM_PROVIDER value', () => {
      process.env.LLM_PROVIDER = 'mistral';
      const { errors } = runValidator();
      expect(errors.some((e) => e.includes('LLM_PROVIDER="mistral" is invalid'))).toBe(true);
    });

    it('warns when the primary provider key is missing (graceful degradation)', () => {
      process.env.LLM_PROVIDER = 'gemini';
      const { errors, warnings } = runValidator();
      expect(errors).toEqual([]);
      expect(warnings.some((w) => w.includes('GEMINI_API_KEY not set'))).toBe(true);
    });

    it('warns about the correct key for each provider', () => {
      process.env.LLM_PROVIDER = 'openai';
      let { warnings } = runValidator();
      expect(warnings.some((w) => w.includes('OPENAI_API_KEY'))).toBe(true);
      expect(warnings.some((w) => w.includes('LLM_PROVIDER=openai'))).toBe(true);
    });
  });

  describe('EMBEDDING_PROVIDER rules', () => {
    it('rejects EMBEDDING_PROVIDER=anthropic explicitly', () => {
      process.env.LLM_PROVIDER = 'gemini';
      process.env.GEMINI_API_KEY = 'test';
      process.env.EMBEDDING_PROVIDER = 'anthropic';
      const { errors } = runValidator();
      expect(
        errors.some((e) => e.includes('EMBEDDING_PROVIDER cannot be "anthropic"'))
      ).toBe(true);
    });

    it('rejects invalid EMBEDDING_PROVIDER value', () => {
      process.env.LLM_PROVIDER = 'gemini';
      process.env.GEMINI_API_KEY = 'test';
      process.env.EMBEDDING_PROVIDER = 'cohere';
      const { errors } = runValidator();
      expect(errors.some((e) => e.includes('EMBEDDING_PROVIDER="cohere" is invalid'))).toBe(true);
    });
  });

  describe('Anthropic primary', () => {
    it('requires EMBEDDING_PROVIDER to be set explicitly when primary=anthropic', () => {
      process.env.LLM_PROVIDER = 'anthropic';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      const { errors } = runValidator();
      expect(
        errors.some((e) => e.includes('LLM_PROVIDER=anthropic requires EMBEDDING_PROVIDER'))
      ).toBe(true);
    });

    it('accepts LLM_PROVIDER=anthropic + EMBEDDING_PROVIDER=openai (with both keys)', () => {
      process.env.LLM_PROVIDER = 'anthropic';
      process.env.EMBEDDING_PROVIDER = 'openai';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      process.env.OPENAI_API_KEY = 'sk-test';
      const { errors, warnings } = runValidator();
      expect(errors).toEqual([]);
      expect(warnings).toEqual([]);
    });

    it('accepts LLM_PROVIDER=anthropic + EMBEDDING_PROVIDER=gemini', () => {
      process.env.LLM_PROVIDER = 'anthropic';
      process.env.EMBEDDING_PROVIDER = 'gemini';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      process.env.GEMINI_API_KEY = 'test';
      const { errors } = runValidator();
      expect(errors).toEqual([]);
    });

    it('hard-errors when EMBEDDING_PROVIDER is set but its key is missing', () => {
      process.env.LLM_PROVIDER = 'anthropic';
      process.env.EMBEDDING_PROVIDER = 'openai';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      // OPENAI_API_KEY deliberately unset
      const { errors } = runValidator();
      expect(
        errors.some((e) => e.includes('OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai'))
      ).toBe(true);
    });

    it('warns (does not error) when anthropic primary key is missing', () => {
      process.env.LLM_PROVIDER = 'anthropic';
      process.env.EMBEDDING_PROVIDER = 'gemini';
      process.env.GEMINI_API_KEY = 'test';
      // ANTHROPIC_API_KEY deliberately unset
      const { errors, warnings } = runValidator();
      expect(errors).toEqual([]);
      expect(warnings.some((w) => w.includes('ANTHROPIC_API_KEY not set'))).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('does not hard-error when embedding === primary and primary key is missing (only warns)', () => {
      process.env.LLM_PROVIDER = 'openai';
      process.env.EMBEDDING_PROVIDER = 'openai';
      // No key
      const { errors, warnings } = runValidator();
      expect(errors).toEqual([]);
      expect(warnings.some((w) => w.includes('OPENAI_API_KEY not set'))).toBe(true);
    });

    it('hard-errors once, not multiple times, when primary is invalid', () => {
      process.env.LLM_PROVIDER = 'fake';
      const { errors } = runValidator();
      expect(errors).toHaveLength(1);
    });
  });
});
