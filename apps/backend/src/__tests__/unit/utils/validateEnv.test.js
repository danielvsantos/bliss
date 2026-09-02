jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { validateLlmConfig, validateEnv } = require('../../../utils/validateEnv');
const logger = require('../../../utils/logger');

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

// ─── validateEnv() full function ─────────────────────────────────────────────

const CRITICAL_ENV_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'INTERNAL_API_KEY',
  'ENCRYPTION_SECRET',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'LLM_PROVIDER',
  'EMBEDDING_PROVIDER',
  'TWELVE_DATA_API_KEY',
  'PLAID_CLIENT_ID',
  'PLAID_SECRET',
  'SENTRY_DSN',
  'NODE_ENV',
];

function setMinimalValidEnv() {
  process.env.DATABASE_URL = 'postgres://localhost/bliss';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.INTERNAL_API_KEY = 'test-api-key-123';
  process.env.ENCRYPTION_SECRET = 'test-encryption-secret';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.LLM_PROVIDER = 'gemini';
  process.env.TWELVE_DATA_API_KEY = 'test-twelve-key';
  process.env.PLAID_CLIENT_ID = 'test-plaid-client';
  process.env.PLAID_SECRET = 'test-plaid-secret';
  process.env.SENTRY_DSN = 'https://sentry.io/123';
}

function clearCriticalEnv() {
  for (const k of CRITICAL_ENV_KEYS) delete process.env[k];
}

describe('validateEnv()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearCriticalEnv();
    setMinimalValidEnv();
  });

  afterEach(() => {
    clearCriticalEnv();
  });

  describe('production mode', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('throws when DATABASE_URL is missing', () => {
      delete process.env.DATABASE_URL;
      expect(() => validateEnv()).toThrow('DATABASE_URL is required');
    });

    it('throws when REDIS_URL is missing', () => {
      delete process.env.REDIS_URL;
      expect(() => validateEnv()).toThrow('REDIS_URL is required');
    });

    it('throws when INTERNAL_API_KEY is missing', () => {
      delete process.env.INTERNAL_API_KEY;
      expect(() => validateEnv()).toThrow('INTERNAL_API_KEY is required');
    });

    it('throws when ENCRYPTION_SECRET is missing', () => {
      delete process.env.ENCRYPTION_SECRET;
      expect(() => validateEnv()).toThrow('ENCRYPTION_SECRET is required');
    });

    it('throws when INTERNAL_API_KEY uses an unsafe default value', () => {
      process.env.INTERNAL_API_KEY = 'changeme';
      expect(() => validateEnv()).toThrow('INTERNAL_API_KEY must not use a default value in production');
    });

    it('throws when INTERNAL_API_KEY uses "your-default-api-key"', () => {
      process.env.INTERNAL_API_KEY = 'your-default-api-key';
      expect(() => validateEnv()).toThrow('must not use a default value in production');
    });

    it('throws when INTERNAL_API_KEY uses "your-secret-key"', () => {
      process.env.INTERNAL_API_KEY = 'your-secret-key';
      expect(() => validateEnv()).toThrow('must not use a default value in production');
    });

    it('throws for multiple missing required vars (lists all errors)', () => {
      delete process.env.DATABASE_URL;
      delete process.env.REDIS_URL;
      let err;
      try {
        validateEnv();
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(err.message).toContain('DATABASE_URL is required');
      expect(err.message).toContain('REDIS_URL is required');
    });

    it('does NOT throw when all required vars are present', () => {
      expect(() => validateEnv()).not.toThrow();
    });
  });

  describe('development mode (non-production)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
    });

    it('does NOT throw when required vars are missing — logs warnings instead', () => {
      delete process.env.DATABASE_URL;
      expect(() => validateEnv()).not.toThrow();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('DATABASE_URL is required')
      );
    });

    it('logs warnings for unsafe INTERNAL_API_KEY in non-production', () => {
      // In dev mode, unsafe default on INTERNAL_API_KEY is NOT an error — only prod throws
      process.env.INTERNAL_API_KEY = 'changeme';
      expect(() => validateEnv()).not.toThrow();
    });

    it('does NOT throw when all required vars are present', () => {
      expect(() => validateEnv()).not.toThrow();
    });
  });

  describe('optional integration warnings', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
    });

    it('warns when TWELVE_DATA_API_KEY is not set', () => {
      delete process.env.TWELVE_DATA_API_KEY;
      validateEnv();
      const warnCalls = logger.warn.mock.calls.map(args => args[0]);
      expect(warnCalls.some(m => m.includes('TWELVE_DATA_API_KEY not set'))).toBe(true);
    });

    it('warns when Plaid credentials are not set', () => {
      delete process.env.PLAID_CLIENT_ID;
      delete process.env.PLAID_SECRET;
      validateEnv();
      const warnCalls = logger.warn.mock.calls.map(args => args[0]);
      expect(warnCalls.some(m => m.includes('Plaid credentials not set'))).toBe(true);
    });

    it('warns when only PLAID_CLIENT_ID is missing', () => {
      delete process.env.PLAID_CLIENT_ID;
      validateEnv();
      const warnCalls = logger.warn.mock.calls.map(args => args[0]);
      expect(warnCalls.some(m => m.includes('Plaid credentials not set'))).toBe(true);
    });

    it('warns when SENTRY_DSN is not set', () => {
      delete process.env.SENTRY_DSN;
      validateEnv();
      const warnCalls = logger.warn.mock.calls.map(args => args[0]);
      expect(warnCalls.some(m => m.includes('SENTRY_DSN not set'))).toBe(true);
    });

    it('does not warn about TWELVE_DATA_API_KEY when set', () => {
      validateEnv();
      const warnCalls = logger.warn.mock.calls.map(args => args[0]);
      expect(warnCalls.some(m => m.includes('TWELVE_DATA_API_KEY'))).toBe(false);
    });

    it('does not warn about Plaid when both credentials are set', () => {
      validateEnv();
      const warnCalls = logger.warn.mock.calls.map(args => args[0]);
      expect(warnCalls.some(m => m.includes('Plaid credentials not set'))).toBe(false);
    });

    it('does not warn about FX auto-fetch when TWELVE_DATA_API_KEY is set (default provider)', () => {
      delete process.env.CURRENCY_PROVIDER;
      delete process.env.CURRENCYLAYER_API_KEY;
      validateEnv();
      const warnCalls = logger.warn.mock.calls.map(args => args[0]);
      expect(warnCalls.some(m => m.includes('automatic FX rate fetching will be unavailable'))).toBe(false);
    });

    it('warns that FX auto-fetch is unavailable when the resolved provider (TWELVE_DATA) has no key', () => {
      delete process.env.CURRENCY_PROVIDER;
      delete process.env.CURRENCYLAYER_API_KEY;
      delete process.env.TWELVE_DATA_API_KEY;
      validateEnv();
      const warnCalls = logger.warn.mock.calls.map(args => args[0]);
      expect(warnCalls.some(m => m.includes('CURRENCY_PROVIDER=TWELVE_DATA but TWELVE_DATA_API_KEY is not set'))).toBe(true);
    });

    it('warns that FX auto-fetch is unavailable when CURRENCY_PROVIDER=CURRENCYLAYER but its key is missing', () => {
      process.env.CURRENCY_PROVIDER = 'CURRENCYLAYER';
      delete process.env.CURRENCYLAYER_API_KEY;
      validateEnv();
      const warnCalls = logger.warn.mock.calls.map(args => args[0]);
      expect(warnCalls.some(m => m.includes('CURRENCY_PROVIDER=CURRENCYLAYER but CURRENCYLAYER_API_KEY is not set'))).toBe(true);
      delete process.env.CURRENCY_PROVIDER;
    });

    it('warns when CURRENCY_PROVIDER is set to an unrecognised value', () => {
      process.env.CURRENCY_PROVIDER = 'yahoo';
      validateEnv();
      const warnCalls = logger.warn.mock.calls.map(args => args[0]);
      expect(warnCalls.some(m => m.includes('CURRENCY_PROVIDER="yahoo" is not recognised'))).toBe(true);
      delete process.env.CURRENCY_PROVIDER;
    });
  });

  describe('NODE_ENV not set (defaults to non-production)', () => {
    beforeEach(() => {
      delete process.env.NODE_ENV;
    });

    it('does not throw when required vars are missing (non-production mode)', () => {
      delete process.env.DATABASE_URL;
      expect(() => validateEnv()).not.toThrow();
    });
  });
});
