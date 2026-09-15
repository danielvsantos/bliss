import { describe, it, expect } from 'vitest';

import { buildSecurityHeaders } from '../../../utils/securityHeaders.js';

function asMap(headers: Array<{ key: string; value: string }>) {
  return Object.fromEntries(headers.map((h) => [h.key, h.value]));
}

describe('buildSecurityHeaders', () => {
  it('always emits the four transport-independent headers', () => {
    const headers = asMap(buildSecurityHeaders('http://localhost:3000'));

    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(headers['Permissions-Policy']).toBe('camera=(), microphone=(), geolocation=()');
  });

  // Sending HSTS from a plain-HTTP self-hosted instance pins the host to HTTPS
  // in the operator's browser and locks them out of their own installation.
  it('omits HSTS when NEXTAUTH_URL is plain HTTP', () => {
    expect(asMap(buildSecurityHeaders('http://localhost:3000'))).not.toHaveProperty(
      'Strict-Transport-Security',
    );
  });

  it('omits HSTS when NEXTAUTH_URL is unset or empty', () => {
    expect(asMap(buildSecurityHeaders(undefined))).not.toHaveProperty(
      'Strict-Transport-Security',
    );
    expect(asMap(buildSecurityHeaders(''))).not.toHaveProperty('Strict-Transport-Security');
  });

  it('emits HSTS when NEXTAUTH_URL is HTTPS', () => {
    const headers = asMap(buildSecurityHeaders('https://app.example.com'));
    expect(headers['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains');
  });

  // CSP is deliberately out of scope (PRD decision D7): it is the one header
  // that can silently break the NextAuth page, the Sentry browser SDK and
  // Plaid Link's iframe. This asserts the decision rather than the absence.
  it('does not set a Content-Security-Policy', () => {
    expect(asMap(buildSecurityHeaders('https://app.example.com'))).not.toHaveProperty(
      'Content-Security-Policy',
    );
  });

  it('reads NEXTAUTH_URL from the environment when no argument is given', () => {
    const saved = process.env.NEXTAUTH_URL;
    try {
      process.env.NEXTAUTH_URL = 'https://env.example.com';
      expect(asMap(buildSecurityHeaders())).toHaveProperty('Strict-Transport-Security');

      process.env.NEXTAUTH_URL = 'http://env.example.com';
      expect(asMap(buildSecurityHeaders())).not.toHaveProperty('Strict-Transport-Security');
    } finally {
      if (saved === undefined) delete process.env.NEXTAUTH_URL;
      else process.env.NEXTAUTH_URL = saved;
    }
  });
});
