/**
 * /api/admin/invites — operator CRUD for the invite allowlist (#99).
 * ADMIN_API_KEY auth (fails closed), normalized emails, 409 contracts, and no
 * email in any log line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { mockPrisma, mockSentry } = vi.hoisted(() => ({
  mockPrisma: {
    signupInvite: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
  mockSentry: { captureException: vi.fn(), init: vi.fn() },
}));

vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));
vi.mock('../../../utils/cors.js', () => ({ cors: () => false }));
vi.mock('@sentry/nextjs', () => mockSentry);

import handler from '../../../pages/api/admin/invites.js';

const KEY = 'operator-admin-key';
const savedKey = process.env.ADMIN_API_KEY;

function makeRes() {
  const res: any = { headers: {} };
  res.status = vi.fn((c: number) => { res._status = c; return res; });
  res.json = vi.fn((b: unknown) => { res._body = b; return res; });
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn((k: string, v: unknown) => { res.headers[k] = v; return res; });
  return res;
}

async function call({
  method = 'GET',
  key = KEY as string | null,
  query = {} as Record<string, unknown>,
  body = undefined as unknown,
} = {}) {
  const res = makeRes();
  const headers: Record<string, string> = {};
  if (key !== null) headers['x-admin-key'] = key;
  await handler({ method, headers, query, body } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res;
}

const invite = {
  id: 'inv1',
  email: 'ana@example.com',
  note: 'Ana – college',
  createdAt: new Date('2026-10-01T00:00:00Z'),
  usedAt: null,
  usedByTenantId: null,
};

let logSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_API_KEY = KEY;
  logSpies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.ADMIN_API_KEY;
  else process.env.ADMIN_API_KEY = savedKey;
  const text = logSpies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).join('\n');
  // Never an email in logs, whatever the outcome.
  expect(text.toLowerCase()).not.toContain('@example.com');
  for (const s of logSpies) s.mockRestore();
});

describe('auth', () => {
  it('401 without x-admin-key', async () => {
    const res = await call({ key: null });
    expect(res._status).toBe(401);
    expect(mockPrisma.signupInvite.findMany).not.toHaveBeenCalled();
  });

  it('401 with a wrong key', async () => {
    expect((await call({ key: 'nope' }))._status).toBe(401);
  });

  it('401 when ADMIN_API_KEY is unset, even with a header (fails closed)', async () => {
    delete process.env.ADMIN_API_KEY;
    expect((await call({ key: '' }))._status).toBe(401);
    expect((await call({ key: 'anything' }))._status).toBe(401);
    expect(mockPrisma.signupInvite.findMany).not.toHaveBeenCalled();
  });
});

describe('POST', () => {
  it('201 with the invite, stored under the normalized email', async () => {
    mockPrisma.signupInvite.create.mockResolvedValue(invite);

    const res = await call({ method: 'POST', body: { email: '  Ana@Example.COM ', note: '  Ana – college ' } });

    expect(res._status).toBe(201);
    expect(res._body).toEqual({ invite });
    expect(mockPrisma.signupInvite.create).toHaveBeenCalledWith({
      data: { email: 'ana@example.com', note: 'Ana – college' },
      select: expect.any(Object),
    });
  });

  it('does not fold dots or plus-tags', async () => {
    mockPrisma.signupInvite.create.mockResolvedValue(invite);
    await call({ method: 'POST', body: { email: 'A.Na+Tag@Example.com' } });
    expect(mockPrisma.signupInvite.create.mock.calls[0][0].data.email).toBe('a.na+tag@example.com');
  });

  it('409 INVITE_EXISTS for a duplicate', async () => {
    mockPrisma.signupInvite.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    const res = await call({ method: 'POST', body: { email: 'ana@example.com' } });
    expect(res._status).toBe(409);
    expect(res._body.code).toBe('INVITE_EXISTS');
  });

  it.each([[undefined], [''], ['not-an-email'], [42]])('400 for invalid email %j', async (email) => {
    const res = await call({ method: 'POST', body: { email } });
    expect(res._status).toBe(400);
    expect(mockPrisma.signupInvite.create).not.toHaveBeenCalled();
  });

  it('400 for a note over 200 characters or not a string', async () => {
    expect((await call({ method: 'POST', body: { email: 'a@b.co', note: 'x'.repeat(201) } }))._status).toBe(400);
    expect((await call({ method: 'POST', body: { email: 'a@b.co', note: 5 } }))._status).toBe(400);
  });

  it('500 without leaking details on an unexpected DB error', async () => {
    mockPrisma.signupInvite.create.mockRejectedValue(new Error('db down'));
    const res = await call({ method: 'POST', body: { email: 'ana@example.com' } });
    expect(res._status).toBe(500);
    expect(res._body).toEqual({ error: 'Internal server error' });
    expect(mockSentry.captureException).toHaveBeenCalled();
  });
});

describe('GET', () => {
  it('lists every invite by default', async () => {
    mockPrisma.signupInvite.findMany.mockResolvedValue([invite]);
    const res = await call();
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ invites: [invite] });
    expect(mockPrisma.signupInvite.findMany.mock.calls[0][0].where).toEqual({});
  });

  it('filters ?status=unused and ?status=used', async () => {
    mockPrisma.signupInvite.findMany.mockResolvedValue([]);
    await call({ query: { status: 'unused' } });
    await call({ query: { status: 'used' } });
    expect(mockPrisma.signupInvite.findMany.mock.calls[0][0].where).toEqual({ usedAt: null });
    expect(mockPrisma.signupInvite.findMany.mock.calls[1][0].where).toEqual({ usedAt: { not: null } });
  });

  it('400 for an unknown status', async () => {
    expect((await call({ query: { status: 'expired' } }))._status).toBe(400);
  });
});

describe('DELETE', () => {
  it('204 revokes an unused invite looked up by normalized email', async () => {
    mockPrisma.signupInvite.findUnique.mockResolvedValue({ id: 'inv1', usedAt: null });
    mockPrisma.signupInvite.deleteMany.mockResolvedValue({ count: 1 });

    const res = await call({ method: 'DELETE', query: { email: ' ANA@example.com' } });

    expect(res._status).toBe(204);
    expect(mockPrisma.signupInvite.findUnique).toHaveBeenCalledWith({
      where: { email: 'ana@example.com' },
      select: { id: true, usedAt: true },
    });
    expect(mockPrisma.signupInvite.deleteMany).toHaveBeenCalledWith({ where: { id: 'inv1', usedAt: null } });
  });

  it('204 revokes by email in the JSON body (kept out of access-log URLs)', async () => {
    mockPrisma.signupInvite.findUnique.mockResolvedValue({ id: 'inv1', usedAt: null });
    mockPrisma.signupInvite.deleteMany.mockResolvedValue({ count: 1 });
    const res = await call({ method: 'DELETE', body: { email: 'Ana@Example.com' } });
    expect(res._status).toBe(204);
    expect(mockPrisma.signupInvite.findUnique.mock.calls[0][0].where).toEqual({ email: 'ana@example.com' });
  });

  it('204 revokes by id', async () => {
    mockPrisma.signupInvite.findUnique.mockResolvedValue({ id: 'inv1', usedAt: null });
    mockPrisma.signupInvite.deleteMany.mockResolvedValue({ count: 1 });
    const res = await call({ method: 'DELETE', query: { id: 'inv1' } });
    expect(res._status).toBe(204);
    expect(mockPrisma.signupInvite.findUnique.mock.calls[0][0].where).toEqual({ id: 'inv1' });
  });

  it('409 INVITE_ALREADY_USED for a used invite (audit history)', async () => {
    mockPrisma.signupInvite.findUnique.mockResolvedValue({ id: 'inv1', usedAt: new Date() });
    const res = await call({ method: 'DELETE', query: { email: 'ana@example.com' } });
    expect(res._status).toBe(409);
    expect(res._body.code).toBe('INVITE_ALREADY_USED');
    expect(mockPrisma.signupInvite.deleteMany).not.toHaveBeenCalled();
  });

  it('409 when the invite is consumed between the read and the delete', async () => {
    mockPrisma.signupInvite.findUnique.mockResolvedValue({ id: 'inv1', usedAt: null });
    mockPrisma.signupInvite.deleteMany.mockResolvedValue({ count: 0 });
    expect((await call({ method: 'DELETE', query: { email: 'ana@example.com' } }))._status).toBe(409);
  });

  it('404 for a missing invite', async () => {
    mockPrisma.signupInvite.findUnique.mockResolvedValue(null);
    const res = await call({ method: 'DELETE', query: { email: 'ana@example.com' } });
    expect(res._status).toBe(404);
  });

  it('400 without email or id', async () => {
    expect((await call({ method: 'DELETE' }))._status).toBe(400);
  });
});

it('405 for other methods', async () => {
  const res = await call({ method: 'PUT' });
  expect(res._status).toBe(405);
  expect(res.headers.Allow).toEqual(['GET', 'POST', 'DELETE']);
});
