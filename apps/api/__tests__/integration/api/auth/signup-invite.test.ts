/**
 * Integration tests for invite-only sign-up (#99) against the real bliss_test
 * Postgres: encryption at rest, single-use consumption (including under
 * concurrency), rollback, FK SetNull on tenant deletion, the no-oracle rule,
 * and existing users still signing in.
 *
 * Rate limiter mocked to a no-op, as in signup.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('../../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
  createRateLimiter: vi.fn().mockReturnValue((_req: unknown, _res: unknown, next: () => void) => next()),
}));

import signupHandler from '../../../../pages/api/auth/signup.js';
import signinHandler from '../../../../pages/api/auth/signin.js';
import invitesHandler from '../../../../pages/api/admin/invites.js';
import prisma from '../../../../prisma/prisma.js';
import { AuthService } from '../../../../services/auth.service.js';

const ADMIN_KEY = 'integration-admin-key';
const INVITE_REQUIRED = {
  error: 'Sign-up on this instance is by invitation only.',
  code: 'SIGNUP_INVITE_REQUIRED',
};

function makeRes() {
  const res: any = { _headers: {} as Record<string, unknown> };
  res.status = vi.fn((c: number) => { res._status = c; return res; });
  res.json = vi.fn((b: unknown) => { res._body = b; return res; });
  res.setHeader = vi.fn((k: string, v: unknown) => { res._headers[k] = v; return res; });
  res.end = vi.fn(() => res);
  return res;
}

function uniqueEmail(tag = 'invite') {
  return `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.bliss`;
}

async function signup(email: string, extra: Record<string, unknown> = {}) {
  const res = makeRes();
  await signupHandler(
    {
      method: 'POST',
      headers: {},
      cookies: {},
      query: {},
      body: {
        email,
        password: 'password123',
        tenantName: `Invite Tenant ${Date.now()}`,
        countries: [],
        currencies: [],
        bankIds: [],
        ...extra,
      },
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  const tenantId = res._body?.user?.tenant?.id;
  if (tenantId) createdTenantIds.add(tenantId);
  return res;
}

async function admin(method: string, { query = {}, body }: { query?: Record<string, string>; body?: unknown } = {}) {
  const res = makeRes();
  await invitesHandler(
    { method, headers: { 'x-admin-key': ADMIN_KEY }, query, body } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return res;
}

async function addInvite(email: string) {
  const res = await admin('POST', { body: { email } });
  expect(res._status).toBe(201);
  createdInviteEmails.add(email.trim().toLowerCase());
  return res._body.invite;
}

async function inviteRow(email: string) {
  return prisma.signupInvite.findUnique({ where: { email: email.trim().toLowerCase() } });
}

const createdTenantIds = new Set<string>();
const createdInviteEmails = new Set<string>();
const saved = { SIGNUP_MODE: process.env.SIGNUP_MODE, ADMIN_API_KEY: process.env.ADMIN_API_KEY };

beforeEach(() => {
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  process.env.SIGNUP_MODE = 'invite_only';
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const email of createdInviteEmails) {
    await prisma.signupInvite.deleteMany({ where: { email } }).catch(() => {});
  }
  for (const tenantId of createdTenantIds) {
    await prisma.user.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  }
});

describe('SignupInvite storage', () => {
  it('stores the email encrypted (deterministic ciphertext), returned decrypted by the API', async () => {
    const email = uniqueEmail();
    const invite = await addInvite(`  ${email.toUpperCase()} `);
    expect(invite.email).toBe(email);

    const [raw] = await prisma.$queryRaw<{ email: string }[]>`SELECT email FROM "SignupInvite" WHERE id = ${invite.id}`;
    expect(raw.email).not.toBe(email);
    expect(raw.email.toLowerCase()).not.toContain('@test.bliss');
  });

  it('rejects a duplicate (after normalization) with 409', async () => {
    const email = uniqueEmail();
    await addInvite(email);
    const res = await admin('POST', { body: { email: email.toUpperCase() } });
    expect(res._status).toBe(409);
    expect(res._body.code).toBe('INVITE_EXISTS');
  });

  it('lists with status filters and revokes an unused invite', async () => {
    const email = uniqueEmail();
    await addInvite(email);

    const unused = await admin('GET', { query: { status: 'unused' } });
    expect(unused._body.invites.map((i: { email: string }) => i.email)).toContain(email);
    const used = await admin('GET', { query: { status: 'used' } });
    expect(used._body.invites.map((i: { email: string }) => i.email)).not.toContain(email);

    const del = await admin('DELETE', { query: { email: email.toUpperCase() } });
    expect(del._status).toBe(204);
    expect(await inviteRow(email)).toBeNull();
  });
});

describe('credentials sign-up in invite-only mode', () => {
  it('lets an invited email sign up once, marks the invite used, then rejects a second attempt', async () => {
    const email = uniqueEmail();
    await addInvite(email);

    const first = await signup(`  ${email.toUpperCase()}  `);
    expect(first._status).toBe(201);
    expect(first._headers['Set-Cookie']).toContain('token=');
    const tenantId = first._body.user.tenant.id;

    const row = await inviteRow(email);
    expect(row?.usedAt).toBeInstanceOf(Date);
    expect(row?.usedByTenantId).toBe(tenantId);

    // A used invite cannot be revoked (audit history).
    const revoke = await admin('DELETE', { query: { email } });
    expect(revoke._status).toBe(409);
    expect(revoke._body.code).toBe('INVITE_ALREADY_USED');

    // Second attempt: no unused invite → the generic 403 (registered or not).
    const second = await signup(email, { password: 'another-password' });
    expect(second._status).toBe(403);
    expect(second._body).toEqual(INVITE_REQUIRED);
  });

  it('rejects an email without an invite and creates nothing', async () => {
    const email = uniqueEmail('stranger');
    const before = await prisma.tenant.count();

    const res = await signup(email);

    expect(res._status).toBe(403);
    expect(res._body).toEqual(INVITE_REQUIRED);
    expect(res._headers['Set-Cookie']).toBeUndefined();
    expect(await prisma.tenant.count()).toBe(before);
  });

  it('creates at most one tenant when two sign-ups race for the same invite', async () => {
    const email = uniqueEmail('race');
    await addInvite(email);

    const [a, b] = await Promise.all([signup(email), signup(email)]);
    const statuses = [a._status, b._status].sort();

    // Exactly one real sign-up (cookie set). The loser gets the invite 403, or
    // the existing-user fake 201 if it lost at the user-existence check.
    const withCookie = [a, b].filter((r) => r._headers['Set-Cookie']);
    expect(withCookie).toHaveLength(1);
    expect(statuses).toContain(201);

    const users = await prisma.user.findMany({ where: { email } });
    expect(users).toHaveLength(1);

    const row = await inviteRow(email);
    expect(row?.usedByTenantId).toBe(users[0].tenantId);
  });

  it('leaves the invite unused when tenant creation fails after consumption (rollback)', async () => {
    const email = uniqueEmail('rollback');
    await addInvite(email);
    vi.spyOn(AuthService, 'createUser').mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await signup(email);

    expect(res._status).toBe(500);
    const row = await inviteRow(email);
    expect(row?.usedAt).toBeNull();
    expect(row?.usedByTenantId).toBeNull();
  });

  it('gives a registered email without an invite the exact response of an unknown email (no oracle)', async () => {
    process.env.SIGNUP_MODE = 'open';
    const registered = uniqueEmail('registered');
    expect((await signup(registered))._status).toBe(201);

    process.env.SIGNUP_MODE = 'invite_only';
    const a = await signup(registered);
    const b = await signup(uniqueEmail('unknown'));

    expect(a._status).toBe(403);
    expect(a._status).toBe(b._status);
    expect(a._body).toEqual(b._body);
    expect(a._headers['Set-Cookie']).toBeUndefined();
    expect(b._headers['Set-Cookie']).toBeUndefined();
  });

  it('still lets an existing user sign in with credentials', async () => {
    process.env.SIGNUP_MODE = 'open';
    const email = uniqueEmail('existing');
    expect((await signup(email))._status).toBe(201);

    process.env.SIGNUP_MODE = 'invite_only';
    const res = makeRes();
    await signinHandler(
      { method: 'POST', headers: {}, cookies: {}, query: {}, body: { email, password: 'password123' } } as unknown as NextApiRequest,
      res as unknown as NextApiResponse,
    );
    expect(res._status).toBe(200);
  });
});

describe('Google first sign-in in invite-only mode', () => {
  it('creates a tenant for an invited Google email and consumes the invite', async () => {
    const email = uniqueEmail('google');
    await addInvite(email);

    const { user, isNew } = await AuthService.findOrCreateGoogleUser({
      email: email.toUpperCase(),
      name: 'Google Friend',
      googleId: `g-${Date.now()}`,
      emailVerified: true,
    });
    createdTenantIds.add(user.tenantId);

    expect(isNew).toBe(true);
    const row = await inviteRow(email);
    expect(row?.usedByTenantId).toBe(user.tenantId);

    // Returning Google user: not gated, even though the invite is now used.
    const again = await AuthService.findOrCreateGoogleUser({
      email,
      name: 'Google Friend',
      googleId: 'ignored',
      emailVerified: true,
    });
    expect(again.isNew).toBe(false);
  });

  it('rejects an uninvited Google email with SIGNUP_INVITE_REQUIRED', async () => {
    await expect(
      AuthService.findOrCreateGoogleUser({
        email: uniqueEmail('google-stranger'),
        name: 'Stranger',
        googleId: 'g-x',
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: 'SIGNUP_INVITE_REQUIRED' });
  });
});

describe('tenant deletion', () => {
  it('nulls usedByTenantId but keeps the used invite as audit history', async () => {
    const email = uniqueEmail('deleted');
    await addInvite(email);
    const res = await signup(email);
    const tenantId = res._body.user.tenant.id;

    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    createdTenantIds.delete(tenantId);

    const row = await inviteRow(email);
    expect(row).not.toBeNull();
    expect(row?.usedAt).toBeInstanceOf(Date);
    expect(row?.usedByTenantId).toBeNull();
  });
});
