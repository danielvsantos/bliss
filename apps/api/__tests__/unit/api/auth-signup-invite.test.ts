/**
 * POST /api/auth/signup — invite-only gate (#99).
 *
 * The invite service is real; Prisma is mocked (including the interactive
 * transaction client), so these pin ordering, the response contract, atomic
 * consumption and the no-plaintext-email logging rule.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { mockPrisma, mockTx, mockAuthService, mockSentry, signupLimiter } = vi.hoisted(() => {
  const mockTx = {
    tenant: { create: vi.fn() },
    signupInvite: { updateMany: vi.fn(), findUnique: vi.fn() },
    tenantCountry: { createMany: vi.fn() },
    tenantCurrency: { createMany: vi.fn() },
    tenantBank: { createMany: vi.fn() },
    category: { createMany: vi.fn() },
  };
  return {
    mockTx,
    mockPrisma: {
      user: { findUnique: vi.fn() },
      signupInvite: { findFirst: vi.fn() },
      country: { findMany: vi.fn() },
      currency: { findMany: vi.fn() },
      bank: { findMany: vi.fn() },
      $transaction: vi.fn(),
    },
    mockAuthService: { createUser: vi.fn() },
    mockSentry: { captureException: vi.fn(), init: vi.fn() },
    signupLimiter: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  };
});

vi.mock('../../../utils/rateLimit.js', () => ({ rateLimiters: { signup: signupLimiter } }));
vi.mock('../../../utils/cors.js', () => ({ cors: () => false }));
vi.mock('@sentry/nextjs', () => mockSentry);
vi.mock('jsonwebtoken', () => ({
  default: { sign: vi.fn().mockReturnValue('mock-jwt') },
  sign: vi.fn().mockReturnValue('mock-jwt'),
}));
vi.mock('uuid', () => ({ v4: vi.fn().mockReturnValue('test-uuid') }));
vi.mock('../../../utils/cookieUtils.js', () => ({ setAuthCookie: vi.fn() }));
vi.mock('../../../lib/defaultCategories.js', () => ({
  DEFAULT_CATEGORIES: [{ code: 'FOOD', name: 'Food', group: 'Daily', type: 'Essentials' }],
}));
vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));
vi.mock('../../../services/auth.service', () => ({ AuthService: mockAuthService }));
vi.mock('../../../services/auth.service.js', () => ({ AuthService: mockAuthService }));

import handler from '../../../pages/api/auth/signup.js';
import { setAuthCookie } from '../../../utils/cookieUtils.js';

const INVITE_REQUIRED = {
  error: 'Sign-up on this instance is by invitation only.',
  code: 'SIGNUP_INVITE_REQUIRED',
};

function makeReq(body: Record<string, unknown>): NextApiRequest {
  return {
    method: 'POST',
    headers: {},
    cookies: {},
    query: {},
    body: { password: 'password123', tenantName: 'My Tenant', countries: [], currencies: [], bankIds: [], ...body },
  } as unknown as NextApiRequest;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn((c: number) => { res._status = c; return res; });
  res.json = vi.fn((b: unknown) => { res._body = b; return res; });
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

async function signup(email: string) {
  const res = makeRes();
  await handler(makeReq({ email }), res as unknown as NextApiResponse);
  return res;
}

let logSpies: ReturnType<typeof vi.spyOn>[] = [];
function loggedText() {
  return logSpies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).join('\n');
}

const savedMode = process.env.SIGNUP_MODE;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET_CURRENT = 'test-jwt-secret';
  mockPrisma.user.findUnique.mockResolvedValue(null);
  mockPrisma.signupInvite.findFirst.mockResolvedValue(null);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockTx));
  mockTx.tenant.create.mockResolvedValue({ id: 'tenant-1', name: 'My Tenant' });
  mockTx.signupInvite.updateMany.mockResolvedValue({ count: 1 });
  mockTx.signupInvite.findUnique.mockResolvedValue({ id: 'invite-1' });
  mockAuthService.createUser.mockResolvedValue({ id: 'user-1', email: 'ana@example.com' });
  logSpies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  if (savedMode === undefined) delete process.env.SIGNUP_MODE;
  else process.env.SIGNUP_MODE = savedMode;
  for (const s of logSpies) s.mockRestore();
});

describe('open mode (SIGNUP_MODE unset or empty)', () => {
  it.each([['unset', undefined], ['empty', '']])('never touches SignupInvite when %s', async (_l, mode) => {
    if (mode === undefined) delete process.env.SIGNUP_MODE;
    else process.env.SIGNUP_MODE = mode;

    const res = await signup('new@example.com');

    expect(res._status).toBe(201);
    expect(mockPrisma.signupInvite.findFirst).not.toHaveBeenCalled();
    expect(mockTx.signupInvite.updateMany).not.toHaveBeenCalled();
    expect(mockTx.tenant.create).toHaveBeenCalledTimes(1);
  });
});

describe('invite-only mode', () => {
  beforeEach(() => {
    process.env.SIGNUP_MODE = 'invite_only';
  });

  it('rejects an unlisted email with the generic 403 and creates nothing', async () => {
    const res = await signup('stranger@example.com');

    expect(res._status).toBe(403);
    expect(res._body).toEqual(INVITE_REQUIRED);
    expect(JSON.stringify(res._body)).not.toContain('stranger');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(setAuthCookie).not.toHaveBeenCalled();
  });

  it('treats an unknown SIGNUP_MODE value as invite-only (fail closed)', async () => {
    process.env.SIGNUP_MODE = 'invite-only';
    const res = await signup('stranger@example.com');
    expect(res._status).toBe(403);
    expect(res._body).toEqual(INVITE_REQUIRED);
  });

  it('looks the invite up by the normalized email, unused only', async () => {
    await signup('  Ana@Example.COM ');
    expect(mockPrisma.signupInvite.findFirst).toHaveBeenCalledWith({
      where: { email: 'ana@example.com', usedAt: null },
      select: { id: true },
    });
  });

  it('lets a listed email create a tenant and consumes the invite in the same transaction', async () => {
    mockPrisma.signupInvite.findFirst.mockResolvedValue({ id: 'invite-1' });

    const res = await signup('  Ana@Example.COM ');

    expect(res._status).toBe(201);
    expect(setAuthCookie).toHaveBeenCalledTimes(1);
    expect(mockTx.signupInvite.updateMany).toHaveBeenCalledWith({
      where: { email: 'ana@example.com', usedAt: null },
      data: { usedAt: expect.any(Date), usedByTenantId: 'tenant-1' },
    });
    // Consumed after the tenant exists (needs its id), before the user is created.
    const consumeOrder = mockTx.signupInvite.updateMany.mock.invocationCallOrder[0];
    expect(mockTx.tenant.create.mock.invocationCallOrder[0]).toBeLessThan(consumeOrder);
    expect(consumeOrder).toBeLessThan(mockAuthService.createUser.mock.invocationCallOrder[0]);
  });

  it('logs signup_invite_consumed with invite and tenant ids, never the email', async () => {
    mockPrisma.signupInvite.findFirst.mockResolvedValue({ id: 'invite-1' });
    await signup('ana@example.com');

    const text = loggedText();
    expect(text).toContain('"event":"signup_invite_consumed"');
    expect(text).toContain('"inviteId":"invite-1"');
    expect(text).toContain('"tenantId":"tenant-1"');
    expect(text.toLowerCase()).not.toContain('ana@example.com');
  });

  it('returns the same 403 when the invite was consumed concurrently (race lost) and does not report to Sentry', async () => {
    mockPrisma.signupInvite.findFirst.mockResolvedValue({ id: 'invite-1' });
    mockTx.signupInvite.updateMany.mockResolvedValue({ count: 0 });

    const res = await signup('ana@example.com');

    expect(res._status).toBe(403);
    expect(res._body).toEqual(INVITE_REQUIRED);
    expect(mockAuthService.createUser).not.toHaveBeenCalled();
    expect(setAuthCookie).not.toHaveBeenCalled();
    expect(mockSentry.captureException).not.toHaveBeenCalled();
  });

  it.each([['a.na@example.com'], ['ana+1@example.com']])(
    'does not fold dots or plus-tags: %s is a different address',
    async (variant) => {
      mockPrisma.signupInvite.findFirst.mockImplementation(async ({ where }: any) =>
        where.email === 'ana@example.com' ? { id: 'invite-1' } : null,
      );
      const res = await signup(variant);
      expect(res._status).toBe(403);
      expect(mockPrisma.signupInvite.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: variant, usedAt: null } }),
      );
    },
  );

  // AC5: the gate runs before the existing-user check, so "registered" and
  // "never seen" are indistinguishable without an invite.
  it('gives a registered email without an invite exactly the response of an unknown email', async () => {
    mockPrisma.user.findUnique.mockImplementation(async ({ where }: any) =>
      where.email === 'member@example.com' ? { id: 'existing' } : null,
    );

    const registered = await signup('member@example.com');
    const unknown = await signup('nobody@example.com');

    expect(registered._status).toBe(unknown._status);
    expect(registered._body).toEqual(unknown._body);
    expect(registered._body).toEqual(INVITE_REQUIRED);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(setAuthCookie).not.toHaveBeenCalled();
  });

  it('a registered email WITH an unused invite still gets the fake 201 and the invite stays unused', async () => {
    mockPrisma.signupInvite.findFirst.mockResolvedValue({ id: 'invite-1' });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'existing' });

    const res = await signup('member@example.com');

    expect(res._status).toBe(201);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockTx.signupInvite.updateMany).not.toHaveBeenCalled();
  });

  it('logs signup_invite_rejected with a fingerprint, never the plaintext email', async () => {
    await signup('Secret.Person@Example.com');

    const text = loggedText();
    expect(text).toContain('"event":"signup_invite_rejected"');
    expect(text).toContain('"path":"credentials"');
    expect(text).toMatch(/"emailFp":"[0-9a-f]{8}"/);
    expect(text.toLowerCase()).not.toContain('secret.person');
    expect(mockSentry.captureException).not.toHaveBeenCalled();
  });

  it('still applies the signup rate limiter before the invite check', async () => {
    signupLimiter.mockImplementationOnce((_req: unknown, res: any) => {
      res.status(429).json({ error: 'Too Many Requests. Please try again later.' });
    });

    const res = makeRes();
    void handler(makeReq({ email: 'stranger@example.com' }), res as unknown as NextApiResponse);
    await new Promise((r) => setTimeout(r, 10));

    expect(res._status).toBe(429);
    expect(mockPrisma.signupInvite.findFirst).not.toHaveBeenCalled();
  });
});
