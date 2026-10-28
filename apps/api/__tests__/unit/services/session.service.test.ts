import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';

import {
  ACCESS_TTL_S,
  hashSecret,
  parseRefreshToken,
  signAccessToken,
  summarizeUserAgent,
} from '../../../services/session.service.js';

describe('session.service helpers (#156)', () => {
  it('parses only well-formed <sessionId>.<secret> values', () => {
    const id = 'a'.repeat(22);
    const secret = 'b'.repeat(43);
    expect(parseRefreshToken(`${id}.${secret}`)).toEqual({ sessionId: id, secret });
    for (const bad of [undefined, '', 'nodot', `${id}.short`, `${id}.${secret}.x`, `bliss_rt_${id}.${secret}`]) {
      expect(parseRefreshToken(bad as any)).toBeNull();
    }
  });

  it('hashes with SHA-256 hex', () => {
    expect(hashSecret('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('summarizes user agents to browser + OS, never the raw header', () => {
    expect(summarizeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1')).toBe('Safari on iOS');
    expect(summarizeUserAgent('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('Edge on Windows');
    expect(summarizeUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36')).toBe('Chrome on Android');
    expect(summarizeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe('Firefox on macOS');
    expect(summarizeUserAgent('curl/8.0')).toBe('Other on Other');
    expect(summarizeUserAgent(undefined)).toBeNull();
    expect(summarizeUserAgent('  ')).toBeNull();
  });

  it('signs a 15-minute access token carrying auth_time and iat_ms', () => {
    const authenticatedAt = new Date('2026-11-01T09:00:00Z');
    const now = new Date();
    const token = signAccessToken({ id: 'u1', tenantId: 't1', email: 'a@b.co' }, authenticatedAt, now);
    const claims = jwt.verify(token, process.env.JWT_SECRET_CURRENT as string) as Record<string, any>;
    expect(claims).toMatchObject({ userId: 'u1', tenantId: 't1', email: 'a@b.co', iat_ms: now.getTime() });
    expect(claims.auth_time).toBe(Math.floor(authenticatedAt.getTime() / 1000));
    expect(claims.exp - claims.iat).toBe(ACCESS_TTL_S);
    expect(typeof claims.jti).toBe('string');
  });
});
