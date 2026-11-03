import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('express-rate-limit', () => ({
  default: vi.fn((_opts: any) => {
    const middleware = vi.fn();
    (middleware as any).__rateLimitOpts = _opts;
    return middleware;
  }),
}));

// Import AFTER mocking so the module picks up the mock
import { createRateLimiter, rateLimiters } from '../../../utils/rateLimit.js';
import rateLimit from 'express-rate-limit';

const mockRateLimit = vi.mocked(rateLimit);

describe('rateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createRateLimiter()', () => {
    it('returns a function (middleware)', () => {
      const limiter = createRateLimiter();
      expect(typeof limiter).toBe('function');
    });

    it('uses default options when none provided', () => {
      createRateLimiter();

      expect(mockRateLimit).toHaveBeenCalledWith(
        expect.objectContaining({
          windowMs: 5 * 60 * 1000,
          max: 100,
          message: { error: 'Too Many Requests. Please try again later.', code: 'RATE_LIMITED' },
          skip: expect.any(Function),
          handler: expect.any(Function),
          standardHeaders: true,
          legacyHeaders: false,
        }),
      );
    });

    it('respects custom max and windowMs options', () => {
      createRateLimiter({ max: 5, windowMs: 60000 });

      expect(mockRateLimit).toHaveBeenCalledWith(
        expect.objectContaining({
          windowMs: 60000,
          max: 5,
        }),
      );
    });

    it('respects custom message option', () => {
      createRateLimiter({ message: 'Slow down!' });

      expect(mockRateLimit).toHaveBeenCalledWith(
        expect.objectContaining({
          message: { error: 'Slow down!', code: 'RATE_LIMITED' },
        }),
      );
    });

    it('provides a keyGenerator function', () => {
      createRateLimiter();

      const opts = mockRateLimit.mock.calls[0][0] as any;
      expect(typeof opts.keyGenerator).toBe('function');
    });

    // #78 R3: a client-set header never picks the bucket by default.
    it('keyGenerator ignores a spoofed x-real-ip / x-forwarded-for when TRUST_PROXY_IP_HEADER is unset', () => {
      vi.stubEnv('TRUST_PROXY_IP_HEADER', '');
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      createRateLimiter();
      const opts = mockRateLimit.mock.calls[0][0] as any;
      const req = { headers: { 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' }, socket: { remoteAddress: '203.0.113.9' } };
      expect(opts.keyGenerator(req)).toBe('203.0.113.9');
      vi.unstubAllEnvs();
    });

    it('keyGenerator honours x-real-ip when TRUST_PROXY_IP_HEADER=x-real-ip', () => {
      vi.stubEnv('TRUST_PROXY_IP_HEADER', 'x-real-ip');
      createRateLimiter();
      const opts = mockRateLimit.mock.calls[0][0] as any;
      const req = { headers: { 'x-real-ip': '1.2.3.4' }, socket: { remoteAddress: '10.0.0.2' } };
      expect(opts.keyGenerator(req)).toBe('1.2.3.4');
      vi.unstubAllEnvs();
    });

    it('skips CORS preflights (OPTIONS never counts)', () => {
      createRateLimiter();
      const opts = mockRateLimit.mock.calls[0][0] as any;
      expect(opts.skip({ method: 'OPTIONS' })).toBe(true);
      expect(opts.skip({ method: 'POST' })).toBe(false);
    });

    it('keyGenerator falls back to socket.remoteAddress', () => {
      createRateLimiter();
      const opts = mockRateLimit.mock.calls[0][0] as any;
      const req = { headers: {}, socket: { remoteAddress: '192.168.1.1' } };
      expect(opts.keyGenerator(req)).toBe('192.168.1.1');
    });

    it('keyGenerator falls back to 127.0.0.1 when no IP source found', () => {
      createRateLimiter();
      const opts = mockRateLimit.mock.calls[0][0] as any;
      const req = { headers: {}, socket: {} };
      expect(opts.keyGenerator(req)).toBe('127.0.0.1');
    });
  });

  describe('rateLimiters', () => {
    const expectedKeys = [
      'signin', 'signup', 'accounts', 'transactions', 'categories',
      'tags', 'session', 'portfolio', 'analytics', 'tenants', 'users',
      'banks', 'countries', 'currencies', 'currencyrates', 'assetprice',
      'openai', 'importsDetect', 'importsUpload', 'importsRead',
      'importsAdapters', 'plaidReview', 'changePassword',
      'signinAccount', 'reauth', 'signout',
    ];

    it('has all expected keys', () => {
      for (const key of expectedKeys) {
        expect(rateLimiters).toHaveProperty(key);
      }
    });

    it('each pre-configured limiter is a function', () => {
      for (const key of expectedKeys) {
        expect(typeof (rateLimiters as any)[key]).toBe('function');
      }
    });
  });
});

describe('limiter keys (#78 D3)', () => {
  it('signinAccount keys on a hash of the email, never the plaintext', () => {
    const opts = (rateLimiters.signinAccount as any).__rateLimitOpts;
    const key = opts.keyGenerator({ signinEmail: 'ana@example.com', headers: {}, socket: {} });
    expect(key).toMatch(/^acct:[0-9a-f]{64}$/);
    expect(key).not.toContain('ana');
    expect(opts.keyGenerator({ signinEmail: 'ana@example.com' })).toBe(key);
    expect(opts.skipSuccessfulRequests).toBe(true);
    expect(opts.max).toBe(10);
    expect(opts.windowMs).toBe(15 * 60 * 1000);
  });

  it('reauth keys per user', () => {
    const opts = (rateLimiters.reauth as any).__rateLimitOpts;
    expect(opts.keyGenerator({ user: { id: 7 }, headers: {}, socket: {} })).toBe('user:7');
  });
});
