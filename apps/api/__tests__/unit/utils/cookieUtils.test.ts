import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  setAuthCookie,
  clearAuthCookie,
  setRefreshCookie,
  clearSessionCookies,
  appendSetCookie,
} from '../../../utils/cookieUtils.js';

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
      expect(cookie).toContain('Max-Age=900');
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

  describe('refresh cookie (#156)', () => {
    function makeHeaderRes() {
      const headers: Record<string, unknown> = {};
      return {
        headers,
        setHeader: vi.fn((k: string, v: unknown) => { headers[k] = v; }),
        getHeader: (k: string) => headers[k],
      } as any;
    }

    it('is HttpOnly, scoped to /api/auth, with the given Max-Age', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.FRONTEND_URL;
      delete process.env.COOKIE_DOMAIN;
      const res = makeRes();

      setRefreshCookie(res, 'sid.secret', 604800.9);

      const cookie: string = res.setHeader.mock.calls[0][1];
      expect(cookie).toContain('bliss_rt=sid.secret');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Path=/api/auth');
      expect(cookie).toContain('Max-Age=604800');
    });

    it('matches the access cookie SameSite/Secure/Domain in cross-origin production', () => {
      process.env.NODE_ENV = 'production';
      process.env.FRONTEND_URL = 'https://app.blissfinance.co';
      process.env.NEXTAUTH_URL = 'https://api.blissfinance.co';
      process.env.COOKIE_DOMAIN = '.blissfinance.co';
      const res = makeHeaderRes();

      setAuthCookie(res, 'jwt');
      setRefreshCookie(res, 'sid.secret', 60);

      const [access, refresh] = res.headers['Set-Cookie'] as string[];
      for (const attr of ['SameSite=None', 'Secure', 'Domain=.blissfinance.co']) {
        expect(access).toContain(attr);
        expect(refresh).toContain(attr);
      }
    });

    it('appends instead of overwriting earlier cookies', () => {
      const res = makeHeaderRes();
      appendSetCookie(res, 'a=1');
      appendSetCookie(res, 'b=2');
      appendSetCookie(res, 'c=3');
      expect(res.headers['Set-Cookie']).toEqual(['a=1', 'b=2', 'c=3']);
    });

    it('clearSessionCookies expires both cookies on their own paths', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.FRONTEND_URL;
      const res = makeHeaderRes();

      clearSessionCookies(res);

      const [access, refresh] = res.headers['Set-Cookie'] as string[];
      expect(access).toMatch(/^token=; /);
      expect(access).toContain('Path=/;');
      expect(access).toContain('Max-Age=0');
      expect(refresh).toMatch(/^bliss_rt=; /);
      expect(refresh).toContain('Path=/api/auth');
      expect(refresh).toContain('Max-Age=0');
    });
  });
});
