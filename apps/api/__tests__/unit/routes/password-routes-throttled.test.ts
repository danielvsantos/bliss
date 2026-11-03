/**
 * #78 R1 — zero unthrottled password-verification paths.
 *
 * Every route that checks a password must be rate-limited. This scans the
 * route tree, so a new password-checking route without a limiter fails here.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

const API_ROOT = join(__dirname, '../../..');
const PAGES = join(API_ROOT, 'pages/api');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.(js|ts)$/.test(name) ? [full] : [];
  });
}

const routes = walk(PAGES).map((file) => ({ file, rel: relative(PAGES, file), src: readFileSync(file, 'utf8') }));

describe('password-checking routes (#78 R1)', () => {
  const checking = routes.filter((r) => /\b(verifyPassword|verifyAndUpgrade)\b/.test(r.src));

  it('are exactly signin, reauth and change-password', () => {
    expect(checking.map((r) => r.rel).sort()).toEqual(['auth/change-password.js', 'auth/reauth.js', 'auth/signin.js']);
  });

  it.each(checking.map((r) => [r.rel, r.src]))('%s is behind a rate limiter', (_rel, src) => {
    expect(src).toMatch(/rateLimiters\.\w+/);
  });

  it('signin also throttles per account', () => {
    expect(routes.find((r) => r.rel === 'auth/signin.js')!.src).toContain('rateLimiters.signinAccount');
  });

  it('NextAuth registers no credentials provider', () => {
    const src = routes.find((r) => r.rel === 'auth/[...nextauth].js')!.src;
    expect(src).not.toMatch(/next-auth\/providers\/credentials/);
    expect(src).not.toMatch(/CredentialsProvider/);
  });
});

describe('NextAuth configuration (#78 R1/R2)', () => {
  it('lists Google only, and its session lives 5 minutes', async () => {
    vi.resetModules();
    vi.stubEnv('GOOGLE_CLIENT_ID', 'id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'secret');
    let captured: any;
    vi.doMock('next-auth', () => ({ default: (opts: any) => { captured = opts; return () => undefined; } }));
    vi.doMock('next-auth/providers/google', () => ({ default: (o: any) => ({ id: 'google', ...o }) }));
    vi.doMock('../../../services/auth.service', () => ({ AuthService: {} }));

    await import('../../../pages/api/auth/[...nextauth].js');

    expect(captured.providers.map((p: any) => p.id)).toEqual(['google']);
    expect(captured.session.maxAge).toBe(300);

    const token = await captured.callbacks.jwt({ token: {}, user: { id: 1, tenantId: 't' } });
    expect(typeof token.signedInAt).toBe('number');
    // Later reads (no `user`) keep the original sign-in time.
    const again = await captured.callbacks.jwt({ token: { ...token } });
    expect(again.signedInAt).toBe(token.signedInAt);

    vi.doUnmock('next-auth');
    vi.doUnmock('next-auth/providers/google');
    vi.doUnmock('../../../services/auth.service');
    vi.unstubAllEnvs();
  });
});
