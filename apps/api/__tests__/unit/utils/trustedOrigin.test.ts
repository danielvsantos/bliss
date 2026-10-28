import { describe, it, expect, vi, afterEach } from 'vitest';

import { isTrustedOrigin, requireTrustedOrigin } from '../../../utils/trustedOrigin.js';

const saved = { NODE_ENV: process.env.NODE_ENV, FRONTEND_URL: process.env.FRONTEND_URL };

function req(headers: Record<string, string>) {
  return { headers } as any;
}

afterEach(() => {
  process.env.NODE_ENV = saved.NODE_ENV;
  process.env.FRONTEND_URL = saved.FRONTEND_URL;
});

describe('trustedOrigin (#156)', () => {
  it('accepts the configured frontend origin, ignoring a trailing slash in FRONTEND_URL', () => {
    process.env.NODE_ENV = 'production';
    process.env.FRONTEND_URL = 'https://app.blissfinance.co/';
    expect(isTrustedOrigin(req({ origin: 'https://app.blissfinance.co' }))).toBe(true);
  });

  it('rejects a foreign Origin even when the Referer is trusted', () => {
    process.env.NODE_ENV = 'production';
    process.env.FRONTEND_URL = 'https://app.blissfinance.co';
    expect(isTrustedOrigin(req({ origin: 'https://evil.example', referer: 'https://app.blissfinance.co/x' }))).toBe(false);
  });

  it('rejects the opaque "null" origin', () => {
    process.env.NODE_ENV = 'production';
    process.env.FRONTEND_URL = 'https://app.blissfinance.co';
    expect(isTrustedOrigin(req({ origin: 'null' }))).toBe(false);
  });

  it('falls back to the Referer origin when Origin is absent', () => {
    process.env.NODE_ENV = 'production';
    process.env.FRONTEND_URL = 'https://app.blissfinance.co';
    expect(isTrustedOrigin(req({ referer: 'https://app.blissfinance.co/settings' }))).toBe(true);
    expect(isTrustedOrigin(req({ referer: 'https://evil.example/' }))).toBe(false);
  });

  it('rejects a request with neither header', () => {
    expect(isTrustedOrigin(req({}))).toBe(false);
  });

  it('trusts localhost dev servers outside production only', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.FRONTEND_URL;
    expect(isTrustedOrigin(req({ origin: 'http://localhost:8080' }))).toBe(true);
    process.env.NODE_ENV = 'production';
    expect(isTrustedOrigin(req({ origin: 'http://localhost:8080' }))).toBe(false);
  });

  it('requireTrustedOrigin answers 403 UNTRUSTED_ORIGIN', () => {
    const res: any = { status: vi.fn(() => res), json: vi.fn(() => res) };
    expect(requireTrustedOrigin(req({ origin: 'https://evil.example' }), res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNTRUSTED_ORIGIN' }));
  });
});
