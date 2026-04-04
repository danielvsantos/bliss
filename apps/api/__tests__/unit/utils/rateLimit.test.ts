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
          message: { error: 'Too Many Requests. Please try again later.' },
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
          message: { error: 'Slow down!' },
        }),
      );
    });

    it('provides a keyGenerator function', () => {
      createRateLimiter();

      const opts = mockRateLimit.mock.calls[0][0] as any;
      expect(typeof opts.keyGenerator).toBe('function');
    });

    it('keyGenerator extracts IP from x-real-ip header', () => {
      createRateLimiter();
      const opts = mockRateLimit.mock.calls[0][0] as any;
      const req = { headers: { 'x-real-ip': '1.2.3.4' }, socket: {} };
      expect(opts.keyGenerator(req)).toBe('1.2.3.4');
    });

    it('keyGenerator falls back to x-forwarded-for (first entry)', () => {
      createRateLimiter();
      const opts = mockRateLimit.mock.calls[0][0] as any;
      const req = { headers: { 'x-forwarded-for': '5.6.7.8, 9.10.11.12' }, socket: {} };
      expect(opts.keyGenerator(req)).toBe('5.6.7.8');
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
