import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes, pbkdf2Sync } from 'crypto';

// auth.service.js imports '../prisma/prisma' (no extension), so the mock must
// use the same specifier the module actually resolves.
vi.mock('../../../prisma/prisma', () => ({
  default: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    tenant: { create: vi.fn() },
    category: { createMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const { AuthService } = await import('../../../services/auth.service.js');
const prisma = (await import('../../../prisma/prisma')).default as any;

/** A row exactly as the pre-remediation code wrote it: PBKDF2-SHA512 @ 1,000. */
function legacyUser(password: string, id = 'user-legacy') {
  const salt = randomBytes(16).toString('hex');
  const hash = pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return { id, passwordHash: hash, passwordSalt: salt };
}

describe('AuthService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('hashPassword', () => {
    it('writes the scrypt format and a null salt', async () => {
      const { hash, salt } = await AuthService.hashPassword('a-password');

      expect(hash.startsWith('$scrypt$')).toBe(true);
      // The scrypt salt lives inside the PHC string; the column is only
      // populated for legacy rows.
      expect(salt).toBeNull();
    });
  });

  describe('verifyPassword', () => {
    it('verifies both storage formats', async () => {
      const { hash } = await AuthService.hashPassword('modern');
      expect(await AuthService.verifyPassword('modern', hash, null)).toBe(true);

      const legacy = legacyUser('ancient');
      expect(
        await AuthService.verifyPassword('ancient', legacy.passwordHash, legacy.passwordSalt),
      ).toBe(true);
    });
  });

  describe('verifyAndUpgrade', () => {
    it('returns true and upgrades a legacy hash to scrypt', async () => {
      const user = legacyUser('legacy-pw');
      prisma.user.update.mockResolvedValue({});

      expect(await AuthService.verifyAndUpgrade(user, 'legacy-pw')).toBe(true);

      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      const arg = prisma.user.update.mock.calls[0][0];
      expect(arg.where).toEqual({ id: user.id });
      expect(arg.data.passwordHash.startsWith('$scrypt$')).toBe(true);
      expect(arg.data.passwordSalt).toBeNull();
    });

    it('stores a hash that verifies the same password afterwards', async () => {
      const user = legacyUser('legacy-pw');
      prisma.user.update.mockResolvedValue({});

      await AuthService.verifyAndUpgrade(user, 'legacy-pw');
      const written = prisma.user.update.mock.calls[0][0].data.passwordHash;

      expect(await AuthService.verifyPassword('legacy-pw', written, null)).toBe(true);
      expect(await AuthService.verifyPassword('wrong', written, null)).toBe(false);
    });

    // Idempotence is structural: needsRehash is false for anything already in
    // scrypt format, so a second login is a no-op rather than a re-encode.
    it('does not rewrite a hash that is already scrypt', async () => {
      const { hash } = await AuthService.hashPassword('already-modern');
      const user = { id: 'u1', passwordHash: hash, passwordSalt: null };

      expect(await AuthService.verifyAndUpgrade(user, 'already-modern')).toBe(true);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('is idempotent across two consecutive logins', async () => {
      const user = legacyUser('legacy-pw');
      prisma.user.update.mockResolvedValue({});

      await AuthService.verifyAndUpgrade(user, 'legacy-pw');
      const upgraded = prisma.user.update.mock.calls[0][0].data.passwordHash;
      prisma.user.update.mockClear();

      // Second login sees the upgraded row.
      const second = { id: user.id, passwordHash: upgraded, passwordSalt: null };
      expect(await AuthService.verifyAndUpgrade(second, 'legacy-pw')).toBe(true);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    // The user supplied the correct password and the old hash still verifies,
    // so a failed rehash write must not fail the login.
    it('still returns true when the rehash write fails', async () => {
      const user = legacyUser('legacy-pw');
      prisma.user.update.mockRejectedValue(new Error('DB write failed'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(AuthService.verifyAndUpgrade(user, 'legacy-pw')).resolves.toBe(true);
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
    });

    it('returns false and never writes for a wrong password', async () => {
      const user = legacyUser('legacy-pw');

      expect(await AuthService.verifyAndUpgrade(user, 'wrong-pw')).toBe(false);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('returns false for an OAuth-only account with no password', async () => {
      expect(
        await AuthService.verifyAndUpgrade({ id: 'u1', passwordHash: null, passwordSalt: null }, 'x'),
      ).toBe(false);
      expect(await AuthService.verifyAndUpgrade(null as never, 'x')).toBe(false);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('email normalization', () => {
    // User.email is deterministically encrypted, so the ciphertext derives from
    // the exact plaintext bytes. Missing one call site produces a login that
    // works for some users and not others — a data-dependent failure that is
    // invisible to fixtures written in lowercase, which is why these fixtures
    // are deliberately mixed-case.
    it('normalizes the lookup key in findUserByEmail', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await AuthService.findUserByEmail('  Mixed.Case@Example.COM ');

      expect(prisma.user.findUnique.mock.calls[0][0].where).toEqual({
        email: 'mixed.case@example.com',
      });
    });

    it('normalizes the stored email in createUser', async () => {
      prisma.user.create.mockResolvedValue({ id: 'u1' });

      await AuthService.createUser({
        email: 'Mixed.Case@Example.COM',
        name: 'M',
        tenantId: 't1',
      });

      expect(prisma.user.create.mock.calls[0][0].data.email).toBe('mixed.case@example.com');
    });

    it('does not strip dots or plus-tags — those change identity semantics', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await AuthService.findUserByEmail('a.b+tag@Example.com');

      expect(prisma.user.findUnique.mock.calls[0][0].where).toEqual({
        email: 'a.b+tag@example.com',
      });
    });
  });

  describe('findOrCreateGoogleUser', () => {
    // Without this check, anyone able to present a Google profile carrying a
    // victim's address could claim that address.
    // Note the string 'true' case: the check is `!== true`, a strict identity
    // test, precisely so a truthy-but-not-boolean claim does not pass.
    it.each([
      ['boolean false', false],
      ['absent', undefined],
      ['null', null],
      ['the STRING "true"', 'true'],
      ['the number 1', 1],
    ])('rejects when email_verified is %s', async (_label, emailVerified) => {
        await expect(
          AuthService.findOrCreateGoogleUser({
            email: 'victim@example.com',
            name: 'V',
            googleId: 'g1',
            emailVerified: emailVerified as never,
          }),
        ).rejects.toMatchObject({ code: AuthService.GOOGLE_EMAIL_UNVERIFIED });

        expect(prisma.user.create).not.toHaveBeenCalled();
        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    // The previous behaviour absorbed any account whose email matched, meaning
    // a Google identity that had never proved control of that account took it
    // over. The row must come out of a rejected attempt completely untouched.
    it('rejects a Google sign-in onto an existing credentials account', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'existing-1',
        email: 'owner@example.com',
        provider: 'credentials',
        providerId: null,
      });

      await expect(
        AuthService.findOrCreateGoogleUser({
          email: 'owner@example.com',
          name: 'Attacker',
          googleId: 'g-attacker',
          emailVerified: true,
        }),
      ).rejects.toMatchObject({ code: AuthService.GOOGLE_ACCOUNT_EXISTS });

      // The existing account is unmodified — no provider conversion, no write.
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('gives the rejection an actionable message', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'existing-1',
        provider: 'credentials',
      });

      await expect(
        AuthService.findOrCreateGoogleUser({
          email: 'owner@example.com',
          name: 'X',
          googleId: 'g1',
          emailVerified: true,
        }),
      ).rejects.toThrow(/sign in with your password/i);
    });

    it('returns an existing Google-linked user unchanged', async () => {
      const existing = {
        id: 'existing-g',
        email: 'g@example.com',
        provider: 'google',
        providerId: 'g1',
        tenantId: 't1',
      };
      prisma.user.findUnique.mockResolvedValue(existing);

      const result = await AuthService.findOrCreateGoogleUser({
        email: 'g@example.com',
        name: 'G',
        googleId: 'g1',
        emailVerified: true,
      });

      expect(result).toEqual({ user: existing, isNew: false });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('creates a new tenant and user for an unknown verified email', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
        fn({
          tenant: { create: vi.fn().mockResolvedValue({ id: 'new-tenant' }) },
          user: { create: vi.fn().mockResolvedValue({ id: 'new-user', tenantId: 'new-tenant' }) },
          category: { createMany: vi.fn().mockResolvedValue({}) },
        }),
      );

      const result = await AuthService.findOrCreateGoogleUser({
        email: 'brand.new@example.com',
        name: 'N',
        googleId: 'g-new',
        emailVerified: true,
      });

      expect(result.isNew).toBe(true);
      expect(result.user.id).toBe('new-user');
    });
  });

  describe('createUser', () => {
    it('stores a scrypt hash and a null salt', async () => {
      prisma.user.create.mockResolvedValue({ id: 'new-user' });

      await AuthService.createUser({
        email: 'a@example.com',
        password: 'a-password',
        name: 'A',
        tenantId: 't1',
      });

      const data = prisma.user.create.mock.calls[0][0].data;
      expect(data.passwordHash.startsWith('$scrypt$')).toBe(true);
      expect(data.passwordSalt).toBeNull();
    });

    it('leaves both password columns null when no password is supplied', async () => {
      prisma.user.create.mockResolvedValue({ id: 'new-user' });

      await AuthService.createUser({
        email: 'oauth@example.com',
        name: 'O',
        tenantId: 't1',
        provider: 'google',
        providerId: 'g1',
      });

      const data = prisma.user.create.mock.calls[0][0].data;
      expect(data.passwordHash).toBeNull();
      expect(data.passwordSalt).toBeNull();
    });
  });
});
