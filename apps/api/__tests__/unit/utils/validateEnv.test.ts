import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { validateEnv } from '../../../utils/validateEnv.js';

describe('validateEnv', () => {
  const savedEnv: Record<string, string | undefined> = {};

  // Keys that validateEnv reads
  const envKeys = [
    'NODE_ENV',
    'DATABASE_URL',
    'JWT_SECRET_CURRENT',
    'ENCRYPTION_SECRET',
    'INTERNAL_API_KEY',
    'NEXTAUTH_SECRET',
    'BACKEND_URL',
    'PLAID_CLIENT_ID',
    'PLAID_SECRET',
    'REDIS_URL',
    'SENTRY_DSN',
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    // Save all env vars we will modify
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    // Restore env vars
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  /** Sets all required env vars to valid values */
  function setAllRequired() {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/bliss';
    process.env.JWT_SECRET_CURRENT = 'a-real-secret-key-for-testing';
    process.env.ENCRYPTION_SECRET = 'test-secret-that-is-exactly-32-by';
    process.env.INTERNAL_API_KEY = 'a-real-internal-api-key';
    process.env.NEXTAUTH_SECRET = 'a-nextauth-secret';
  }

  /** Sets all optional vars too */
  function setAllOptional() {
    process.env.BACKEND_URL = 'http://localhost:3001';
    process.env.PLAID_CLIENT_ID = 'plaid-client-id';
    process.env.PLAID_SECRET = 'plaid-secret';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.SENTRY_DSN = 'https://sentry.io/dsn';
  }

  describe('when all required vars are set', () => {
    it('does not throw or warn on errors', () => {
      setAllRequired();
      setAllOptional();
      process.env.NODE_ENV = 'development';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => validateEnv()).not.toThrow();
      // Should not have any error-level warnings (may have optional warnings)
      const errorWarns = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes('validation failed'),
      );
      expect(errorWarns).toHaveLength(0);
      warnSpy.mockRestore();
    });
  });

  describe('optional vars warnings', () => {
    it('warns when BACKEND_URL is missing', () => {
      setAllRequired();
      delete process.env.BACKEND_URL;
      process.env.PLAID_CLIENT_ID = 'x';
      process.env.PLAID_SECRET = 'x';
      process.env.REDIS_URL = 'redis://localhost';
      process.env.SENTRY_DSN = 'https://sentry.io';
      process.env.NODE_ENV = 'development';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      validateEnv();
      const msgs = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(msgs.some((m) => m.includes('BACKEND_URL'))).toBe(true);
      warnSpy.mockRestore();
    });

    it('warns when Plaid credentials are missing', () => {
      setAllRequired();
      setAllOptional();
      delete process.env.PLAID_CLIENT_ID;
      delete process.env.PLAID_SECRET;
      process.env.NODE_ENV = 'development';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      validateEnv();
      const msgs = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(msgs.some((m) => m.includes('Plaid'))).toBe(true);
      warnSpy.mockRestore();
    });

    it('warns when REDIS_URL is missing', () => {
      setAllRequired();
      setAllOptional();
      delete process.env.REDIS_URL;
      process.env.NODE_ENV = 'development';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      validateEnv();
      const msgs = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(msgs.some((m) => m.includes('REDIS_URL'))).toBe(true);
      warnSpy.mockRestore();
    });

    it('warns when SENTRY_DSN is missing', () => {
      setAllRequired();
      setAllOptional();
      delete process.env.SENTRY_DSN;
      process.env.NODE_ENV = 'development';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      validateEnv();
      const msgs = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(msgs.some((m) => m.includes('SENTRY_DSN'))).toBe(true);
      warnSpy.mockRestore();
    });
  });

  describe('missing critical vars (development)', () => {
    it('warns (does not throw) on missing DATABASE_URL in dev', () => {
      setAllRequired();
      delete process.env.DATABASE_URL;
      process.env.NODE_ENV = 'development';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => validateEnv()).not.toThrow();
      const msgs = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(msgs.some((m) => m.includes('DATABASE_URL'))).toBe(true);
      warnSpy.mockRestore();
    });

    it('warns on missing JWT_SECRET_CURRENT in dev', () => {
      setAllRequired();
      delete process.env.JWT_SECRET_CURRENT;
      process.env.NODE_ENV = 'development';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => validateEnv()).not.toThrow();
      const msgs = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(msgs.some((m) => m.includes('JWT_SECRET_CURRENT'))).toBe(true);
      warnSpy.mockRestore();
    });

    it('warns on missing ENCRYPTION_SECRET in dev', () => {
      setAllRequired();
      delete process.env.ENCRYPTION_SECRET;
      process.env.NODE_ENV = 'development';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => validateEnv()).not.toThrow();
      const msgs = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(msgs.some((m) => m.includes('ENCRYPTION_SECRET'))).toBe(true);
      warnSpy.mockRestore();
    });

    it('warns on missing INTERNAL_API_KEY in dev', () => {
      setAllRequired();
      delete process.env.INTERNAL_API_KEY;
      process.env.NODE_ENV = 'development';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => validateEnv()).not.toThrow();
      const msgs = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(msgs.some((m) => m.includes('INTERNAL_API_KEY'))).toBe(true);
      warnSpy.mockRestore();
    });
  });

  describe('missing critical vars (production)', () => {
    it('throws on missing DATABASE_URL', () => {
      setAllRequired();
      delete process.env.DATABASE_URL;
      process.env.NODE_ENV = 'production';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => validateEnv()).toThrow('Environment validation failed');
      expect(() => validateEnv()).toThrow('DATABASE_URL');
      warnSpy.mockRestore();
    });

    it('throws on missing JWT_SECRET_CURRENT', () => {
      setAllRequired();
      delete process.env.JWT_SECRET_CURRENT;
      process.env.NODE_ENV = 'production';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => validateEnv()).toThrow('JWT_SECRET_CURRENT');
      warnSpy.mockRestore();
    });

    it('throws on missing ENCRYPTION_SECRET', () => {
      setAllRequired();
      delete process.env.ENCRYPTION_SECRET;
      process.env.NODE_ENV = 'production';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => validateEnv()).toThrow('ENCRYPTION_SECRET');
      warnSpy.mockRestore();
    });

    it('throws on missing INTERNAL_API_KEY', () => {
      setAllRequired();
      delete process.env.INTERNAL_API_KEY;
      process.env.NODE_ENV = 'production';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => validateEnv()).toThrow('INTERNAL_API_KEY');
      warnSpy.mockRestore();
    });

    it('throws on missing NEXTAUTH_SECRET', () => {
      setAllRequired();
      delete process.env.NEXTAUTH_SECRET;
      process.env.NODE_ENV = 'production';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => validateEnv()).toThrow('NEXTAUTH_SECRET');
      warnSpy.mockRestore();
    });
  });

  describe('unsafe default values in production', () => {
    it('throws when JWT_SECRET_CURRENT is an unsafe default', () => {
      setAllRequired();
      process.env.JWT_SECRET_CURRENT = 'changeme';
      process.env.NODE_ENV = 'production';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => validateEnv()).toThrow('JWT_SECRET_CURRENT must not use a default value');
      warnSpy.mockRestore();
    });

    it('throws when JWT_SECRET_CURRENT is "your-secret-key"', () => {
      setAllRequired();
      process.env.JWT_SECRET_CURRENT = 'your-secret-key';
      process.env.NODE_ENV = 'production';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => validateEnv()).toThrow('JWT_SECRET_CURRENT must not use a default value');
      warnSpy.mockRestore();
    });

    it('throws when INTERNAL_API_KEY is an unsafe default', () => {
      setAllRequired();
      process.env.INTERNAL_API_KEY = 'your-default-api-key';
      process.env.NODE_ENV = 'production';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => validateEnv()).toThrow('INTERNAL_API_KEY must not use a default value');
      warnSpy.mockRestore();
    });

    it('does not throw for unsafe defaults in development', () => {
      setAllRequired();
      process.env.JWT_SECRET_CURRENT = 'changeme';
      process.env.INTERNAL_API_KEY = 'your-default-api-key';
      process.env.NODE_ENV = 'development';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => validateEnv()).not.toThrow();
      warnSpy.mockRestore();
    });
  });
});
