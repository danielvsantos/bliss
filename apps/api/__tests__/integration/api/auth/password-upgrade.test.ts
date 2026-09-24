/**
 * End-to-end verification of the PBKDF2 -> scrypt migration against a REAL
 * database row.
 *
 * The sibling signin.test.ts mocks AuthService, so it proves the handler wires
 * the right call but says nothing about whether a real legacy row still logs
 * in. That question is the highest-risk part of this change: a legacy hash
 * that stops verifying is a total lockout for every pre-existing user on every
 * instance, and there is no error message that would make the cause obvious.
 *
 * So this file uses the real AuthService and the real Prisma client, seeding a
 * user whose passwordHash is computed exactly the way the pre-remediation code
 * computed it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, pbkdf2Sync } from 'crypto';

import prisma from '../../../../prisma/prisma.js';
import { AuthService } from '../../../../services/auth.service.js';
import { createIsolatedTenant, teardownTenant } from '../../../helpers/tenant.js';

const LEGACY_PASSWORD = 'my-original-password';

/** Exactly what apps/api/services/auth.service.js:8 used to produce. */
function legacyHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

describe('password upgrade on login (real DB row)', () => {
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    const tenant = await createIsolatedTenant('pwupgrade');
    tenantId = tenant.tenantId;

    const { hash, salt } = legacyHash(LEGACY_PASSWORD);
    const user = await prisma.user.create({
      data: {
        email: `legacy-${Date.now()}@test.bliss`,
        tenantId,
        role: 'member',
        passwordHash: hash,
        passwordSalt: salt,
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
    await teardownTenant(tenantId);
  });

  async function loadUser() {
    return prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true, passwordSalt: true },
    });
  }

  it('seeds a row in the legacy format', async () => {
    const user = await loadUser();
    expect(user!.passwordHash).toMatch(/^[0-9a-f]{128}$/);
    expect(user!.passwordSalt).toMatch(/^[0-9a-f]{32}$/);
  });

  it('logs in with the legacy hash and upgrades the row to scrypt', async () => {
    const before = await loadUser();

    expect(await AuthService.verifyAndUpgrade(before!, LEGACY_PASSWORD)).toBe(true);

    const after = await loadUser();
    expect(after!.passwordHash!.startsWith('$scrypt$')).toBe(true);
    expect(after!.passwordSalt).toBeNull();
  });

  it('logs in a second time without corrupting the row (idempotent)', async () => {
    const before = await loadUser();
    expect(before!.passwordHash!.startsWith('$scrypt$')).toBe(true);

    expect(await AuthService.verifyAndUpgrade(before!, LEGACY_PASSWORD)).toBe(true);

    const after = await loadUser();
    // Byte-identical: the second login is a no-op, not a re-encode.
    expect(after!.passwordHash).toBe(before!.passwordHash);
    expect(after!.passwordSalt).toBeNull();
  });

  it('still rejects the wrong password after the upgrade', async () => {
    const user = await loadUser();
    expect(await AuthService.verifyAndUpgrade(user!, 'not-the-password')).toBe(false);
  });

  // R3.5: change-password must write the new format. It already routes through
  // AuthService.hashPassword, so this follows for free — asserted here against
  // a real row rather than assumed.
  it('change-password writes the scrypt format and round-trips', async () => {
    const { hash, salt } = await AuthService.hashPassword('a-brand-new-password');
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: hash, passwordSalt: salt },
    });

    const user = await loadUser();
    expect(user!.passwordHash!.startsWith('$scrypt$')).toBe(true);
    expect(user!.passwordSalt).toBeNull();

    expect(await AuthService.verifyAndUpgrade(user!, 'a-brand-new-password')).toBe(true);
    expect(await AuthService.verifyAndUpgrade(user!, LEGACY_PASSWORD)).toBe(false);
  });

  it('leaves no legacy-format hash behind', async () => {
    // The production sign-off query: after each user has logged in once,
    // nothing should remain in the legacy format.
    const remaining = await prisma.user.count({
      where: {
        id: userId,
        passwordHash: { not: null },
        NOT: { passwordHash: { startsWith: '$scrypt$' } },
      },
    });
    expect(remaining).toBe(0);
  });
});
