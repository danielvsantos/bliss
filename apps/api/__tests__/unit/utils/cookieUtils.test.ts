import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { setAuthCookie, clearAuthCookie } from '../../../utils/cookieUtils.js';

function makeRes() {
  return { setHeader: vi.fn() } as any;
}

describe('cookieUtils', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    // Save env vars that our tests modify
    savedEnv.NODE_ENV = process.env.NODE_ENV;
    savedEnv.FRONTEND_URL = process.env.FRONTEND_URL;
    savedEnv.NEXTAUTH_URL = process.env.NEXTAUTH_URL;
    savedEnv.COOKIE_DOMAIN = process.env.COOKIE_DOMAIN;
  });

  afterEach(() => {
    // Restore env vars
    process.env.NODE_ENV = savedEnv.NODE_ENV;
    process.env.FRONTEND_URL = savedEnv.FRONTEND_URL;
    process.env.NEXTAUTH_URL = savedEnv.NEXTAUTH_URL;
    process.env.COOKIE_DOMAIN = savedEnv.COOKIE_DOMAIN;
  });

  describe('setAuthCookie()', () => {
    it('sets HttpOnly, Path=/, SameSite=Lax, Max-Age in same-origin dev', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.FRONTEND_URL;
      delete process.env.COOKIE_DOMAIN;
      const res = makeRes();

      setAuthCookie(res, 'my-jwt-token');

      const cookie: string = res.setHeader.mock.calls[0][1];
      expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', expect.any(String));
      expect(cookie).toContain('token=my-jwt-token');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Max-Age=86400');
    });

    it('uses SameSite=None + Secure when cross-origin', () => {
      process.env.NODE_ENV = 'development';
      process.env.FRONTEND_URL = 'http://localhost:8080';
      process.env.NEXTAUTH_URL = 'http://localhost:3000';
      delete process.env.COOKIE_DOMAIN;
      const res = makeRes();

      setAuthCookie(res, 'cross-origin-token');

      const cookie: string = res.setHeader.mock.calls[0][1];
      expect(cookie).toContain('SameSite=None');
      expect(cookie).toContain('Secure');
    });

    it('includes Secure and Domain in production with COOKIE_DOMAIN', () => {
      process.env.NODE_ENV = 'production';
      process.env.NEXTAUTH_URL = 'https://api.blissfinance.co';
      process.env.FRONTEND_URL = 'https://app.blissfinance.co';
      process.env.COOKIE_DOMAIN = '.blissfinance.co';
      const res = makeRes();

      setAuthCookie(res, 'prod-token');

      const cookie: string = res.setHeader.mock.calls[0][1];
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('Domain=.blissfinance.co');
      expect(cookie).toContain('SameSite=None');
    });

    it('excludes Secure and Domain in development same-origin', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.FRONTEND_URL;
      delete process.env.COOKIE_DOMAIN;
      const res = makeRes();

      setAuthCookie(res, 'dev-token');

      const cookie: string = res.setHeader.mock.calls[0][1];
      expect(cookie).not.toContain('Secure');
      expect(cookie).not.toContain('Domain=');
    });

    it('includes Secure in production same-origin HTTPS', () => {
      process.env.NODE_ENV = 'production';
      process.env.NEXTAUTH_URL = 'https://api.blissfinance.co';
      delete process.env.FRONTEND_URL;
      delete process.env.COOKIE_DOMAIN;
      const res = makeRes();

      setAuthCookie(res, 'same-origin-prod-token');

      const cookie: string = res.setHeader.mock.calls[0][1];
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Lax');
    });
  });

  describe('clearAuthCookie()', () => {
    it('sets Max-Age=0 to expire the cookie', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.FRONTEND_URL;
      delete process.env.COOKIE_DOMAIN;
      const res = makeRes();

      clearAuthCookie(res);

      const cookie: string = res.setHeader.mock.calls[0][1];
      expect(cookie).toContain('token=');
      expect(cookie).toContain('Max-Age=0');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain('SameSite=Lax');
    });

    it('matches cross-origin attributes when FRONTEND_URL differs from API', () => {
      process.env.NODE_ENV = 'production';
      process.env.FRONTEND_URL = 'https://app.blissfinance.co';
      process.env.NEXTAUTH_URL = 'https://api.blissfinance.co';
      process.env.COOKIE_DOMAIN = '.blissfinance.co';
      const res = makeRes();

      clearAuthCookie(res);

      const cookie: string = res.setHeader.mock.calls[0][1];
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('Domain=.blissfinance.co');
      expect(cookie).toContain('SameSite=None');
    });
  });
});
