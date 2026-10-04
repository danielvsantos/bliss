/**
 * AuthService.findOrCreateGoogleUser — invite-only gate (#99), plus the
 * NextAuth signIn callback mapping of the new error code.
 *
 * Only the create branch is gated: a returning Google user signs in whatever
 * SIGNUP_MODE is.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockPrisma, mockTx, nextAuthConfig } = vi.hoisted(() => {
  const mockTx = {
    tenant: { create: vi.fn() },
    user: { create: vi.fn() },
    category: { createMany: vi.fn() },
    signupInvite: { updateMany: vi.fn(), findUnique: vi.fn() },
  };
  return {
    mockTx,
    mockPrisma: {
      user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
      signupInvite: { findFirst: vi.fn() },
      $transaction: vi.fn(),
    },
    nextAuthConfig: { current: null as any },
  };
});

vi.mock('../../../prisma/prisma', () => ({ default: mockPrisma }));
vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));
vi.mock('next-auth', () => ({
  default: (config: unknown) => {
    nextAuthConfig.current = config;
    return () => undefined;
  },
}));
vi.mock('next-auth/providers/google', () => ({ default: (o: unknown) => ({ id: 'google', ...(o as object) }) }));
vi.mock('next-auth/providers/credentials', () => ({ default: (o: unknown) => ({ id: 'credentials', ...(o as object) }) }));
vi.mock('next-auth/jwt', () => ({ encode: vi.fn(), decode: vi.fn() }));

const { AuthService } = await import('../../../services/auth.service.js');

const profile = { email: 'Friend@Example.com', name: 'Friend', googleId: 'g-friend', emailVerified: true };
const savedMode = process.env.SIGNUP_MODE;
const savedFrontend = process.env.FRONTEND_URL;
let logSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.user.findUnique.mockResolvedValue(null);
  mockPrisma.signupInvite.findFirst.mockResolvedValue(null);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockTx));
  mockTx.tenant.create.mockResolvedValue({ id: 'tenant-g' });
  mockTx.user.create.mockResolvedValue({ id: 'user-g', tenantId: 'tenant-g' });
  mockTx.category.createMany.mockResolvedValue({ count: 1 });
  mockTx.signupInvite.updateMany.mockResolvedValue({ count: 1 });
  mockTx.signupInvite.findUnique.mockResolvedValue({ id: 'invite-g' });
  logSpies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  if (savedMode === undefined) delete process.env.SIGNUP_MODE;
  else process.env.SIGNUP_MODE = savedMode;
  if (savedFrontend === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = savedFrontend;
  for (const s of logSpies) s.mockRestore();
});

function loggedText() {
  return logSpies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).join('\n');
}

describe('findOrCreateGoogleUser in open mode', () => {
  it('creates a tenant without any invite lookup', async () => {
    delete process.env.SIGNUP_MODE;
    const result = await AuthService.findOrCreateGoogleUser(profile);
    expect(result.isNew).toBe(true);
    expect(mockPrisma.signupInvite.findFirst).not.toHaveBeenCalled();
    expect(mockTx.signupInvite.updateMany).not.toHaveBeenCalled();
  });
});

describe('findOrCreateGoogleUser in invite-only mode', () => {
  beforeEach(() => {
    process.env.SIGNUP_MODE = 'invite_only';
  });

  it('rejects a first sign-in without an invite with SIGNUP_INVITE_REQUIRED and creates nothing', async () => {
    await expect(AuthService.findOrCreateGoogleUser(profile)).rejects.toMatchObject({
      code: 'SIGNUP_INVITE_REQUIRED',
    });
    expect(AuthService.SIGNUP_INVITE_REQUIRED).toBe('SIGNUP_INVITE_REQUIRED');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();

    const text = loggedText();
    expect(text).toContain('"event":"signup_invite_rejected"');
    expect(text).toContain('"path":"google"');
    expect(text.toLowerCase()).not.toContain('friend@example.com');
  });

  it('lets an invited Google email create a tenant and consumes the invite atomically', async () => {
    mockPrisma.signupInvite.findFirst.mockResolvedValue({ id: 'invite-g' });

    const result = await AuthService.findOrCreateGoogleUser(profile);

    expect(result.isNew).toBe(true);
    expect(mockPrisma.signupInvite.findFirst).toHaveBeenCalledWith({
      where: { email: 'friend@example.com', usedAt: null },
      select: { id: true },
    });
    expect(mockTx.signupInvite.updateMany).toHaveBeenCalledWith({
      where: { email: 'friend@example.com', usedAt: null },
      data: { usedAt: expect.any(Date), usedByTenantId: 'tenant-g' },
    });
    expect(loggedText().toLowerCase()).not.toContain('friend@example.com');
  });

  it('propagates SIGNUP_INVITE_REQUIRED when a concurrent sign-in consumed the invite first', async () => {
    mockPrisma.signupInvite.findFirst.mockResolvedValue({ id: 'invite-g' });
    mockTx.signupInvite.updateMany.mockResolvedValue({ count: 0 });

    await expect(AuthService.findOrCreateGoogleUser(profile)).rejects.toMatchObject({
      code: 'SIGNUP_INVITE_REQUIRED',
    });
    expect(mockTx.user.create).not.toHaveBeenCalled();
  });

  it('never gates a returning Google user', async () => {
    const existing = { id: 'u1', email: 'friend@example.com', provider: 'google', tenantId: 't1' };
    mockPrisma.user.findUnique.mockResolvedValue(existing);

    const result = await AuthService.findOrCreateGoogleUser(profile);

    expect(result).toEqual({ user: existing, isNew: false });
    expect(mockPrisma.signupInvite.findFirst).not.toHaveBeenCalled();
  });

  it('keeps rejecting an unverified email before the invite check', async () => {
    mockPrisma.signupInvite.findFirst.mockResolvedValue({ id: 'invite-g' });
    await expect(
      AuthService.findOrCreateGoogleUser({ ...profile, emailVerified: false }),
    ).rejects.toMatchObject({ code: AuthService.GOOGLE_EMAIL_UNVERIFIED });
    expect(mockPrisma.signupInvite.findFirst).not.toHaveBeenCalled();
  });
});

describe('NextAuth signIn callback error mapping', () => {
  async function signInWith(error: Error & { code?: string }) {
    process.env.FRONTEND_URL = 'https://app.example.com';
    await import('../../../pages/api/auth/[...nextauth].js');
    const spy = vi.spyOn(AuthService, 'findOrCreateGoogleUser').mockRejectedValueOnce(error);
    try {
      return await nextAuthConfig.current.callbacks.signIn({
        user: {},
        account: { provider: 'google' },
        profile: { email: 'x@example.com', name: 'X', sub: 'g', email_verified: true },
      });
    } finally {
      spy.mockRestore();
    }
  }

  it.each([
    ['SIGNUP_INVITE_REQUIRED', 'signup_invite_required'],
    ['GOOGLE_ACCOUNT_EXISTS', 'google_account_exists'],
    ['GOOGLE_EMAIL_UNVERIFIED', 'google_email_unverified'],
    ['SOMETHING_ELSE', 'oauth_failed'],
  ])('maps %s to ?error=%s', async (code, query) => {
    const err = Object.assign(new Error('x'), { code });
    await expect(signInWith(err)).resolves.toBe(`https://app.example.com/auth?error=${query}`);
  });
});
