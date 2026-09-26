import { describe, it, expect } from 'vitest';

import {
  buildSecurityHeaders,
  buildHeaderRules,
  HSTS_HEADER,
} from '../../../utils/securityHeaders.js';

type HeaderRule = {
  source: string;
  headers: Array<{ key: string; value: string }>;
  has?: Array<{ type: string; key: string; value?: string }>;
};

function keysOf(headers: Array<{ key: string }>) {
  return headers.map((h) => h.key);
}

describe('buildSecurityHeaders', () => {
  it('emits the four transport-independent headers', () => {
    const keys = keysOf(buildSecurityHeaders());

    expect(keys).toEqual([
      'X-Content-Type-Options',
      'Referrer-Policy',
      'X-Frame-Options',
      'Permissions-Policy',
    ]);
  });

  it('takes no arguments and reads no environment', () => {
    // Regression guard. HSTS used to be gated on process.env.NEXTAUTH_URL
    // inside this function, which is dead code: Next evaluates headers() at
    // BUILD time and bakes the result into routes-manifest.json, and
    // NEXTAUTH_URL is a runtime variable absent during `docker build`. The
    // header silently never shipped. Anything env-dependent belongs in a `has`
    // matcher, not here.
    const saved = process.env.NEXTAUTH_URL;
    try {
      process.env.NEXTAUTH_URL = 'https://app.example.com';
      const withHttps = keysOf(buildSecurityHeaders());

      process.env.NEXTAUTH_URL = 'http://localhost:3000';
      const withHttp = keysOf(buildSecurityHeaders());

      delete process.env.NEXTAUTH_URL;
      const withNothing = keysOf(buildSecurityHeaders());

      expect(withHttps).toEqual(withHttp);
      expect(withHttps).toEqual(withNothing);
    } finally {
      if (saved === undefined) delete process.env.NEXTAUTH_URL;
      else process.env.NEXTAUTH_URL = saved;
    }
  });

  it('does not set a Content-Security-Policy (deliberately out of scope)', () => {
    expect(keysOf(buildSecurityHeaders())).not.toContain('Content-Security-Policy');
  });
});

describe('buildHeaderRules', () => {
  const rules = () => buildHeaderRules() as HeaderRule[];

  it('applies the base headers to every path unconditionally', () => {
    const base = rules().find((r) => !r.has);

    expect(base).toBeDefined();
    expect(base!.source).toBe('/(.*)');
    expect(keysOf(base!.headers)).toEqual(keysOf(buildSecurityHeaders()));
  });

  // Sending HSTS to a plain-HTTP self-hoster pins the host to HTTPS in their
  // browser and locks them out of their own instance. It must never be
  // unconditional.
  it('never emits HSTS from an unconditional rule', () => {
    for (const rule of rules()) {
      if (!rule.has) {
        expect(keysOf(rule.headers)).not.toContain('Strict-Transport-Security');
      }
    }
  });

  it('gates HSTS on the request protocol, not on configuration', () => {
    const hsts = rules().find((r) => keysOf(r.headers).includes('Strict-Transport-Security'));

    expect(hsts).toBeDefined();
    expect(hsts!.source).toBe('/(.*)');
    // A `has` matcher is compiled into the manifest as a condition and
    // evaluated per request — unlike anything read from process.env here,
    // which would be frozen at build time.
    expect(hsts!.has).toEqual([
      { type: 'header', key: 'x-forwarded-proto', value: 'https' },
    ]);
    expect(hsts!.headers).toEqual([HSTS_HEADER]);
  });

  it('sets a one-year max-age covering subdomains', () => {
    expect(HSTS_HEADER.value).toBe('max-age=31536000; includeSubDomains');
  });

  it('scopes every rule to all paths', () => {
    for (const rule of rules()) {
      expect(rule.source).toBe('/(.*)');
    }
  });
});
