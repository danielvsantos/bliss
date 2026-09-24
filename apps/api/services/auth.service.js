import prisma from '../prisma/prisma';
import { DEFAULT_CATEGORIES } from '../lib/defaultCategories.js';
import { hashPassword, verifyPassword, needsRehash } from './password.js';

export class AuthService {
  /**
   * Hash a password in the current (scrypt) format.
   *
   * Returns `{ hash, salt }` to keep the existing call signature. `salt` is
   * always null now — the scrypt salt lives inside the PHC string in `hash`,
   * and `User.passwordSalt` is only populated on legacy rows.
   */
  static async hashPassword(password) {
    const hash = await hashPassword(password);
    return { hash, salt: null };
  }

  /**
   * Verify against either storage format. See services/password.js.
   */
  static async verifyPassword(password, hash, salt) {
    return verifyPassword(password, hash, salt);
  }

  /**
   * Verify a password and, on success, transparently upgrade a legacy
   * PBKDF2-1,000 hash to scrypt.
   *
   * Rehash-on-login is the ONLY mechanism that can perform this migration: a
   * script cannot rehash a password, because PBKDF2 is one-way and there is
   * nothing to re-derive without the plaintext. It also works for self-hosters,
   * who do not have their users' plaintexts.
   *
   * The rehash write is deliberately **best-effort**. A failed write must not
   * fail the login — the user supplied the correct password, and the old hash
   * still verifies, so the next login simply tries the upgrade again.
   *
   * Idempotent by construction: `needsRehash` returns false for anything
   * already in scrypt format, so a second login is a no-op.
   *
   * @param {{ id: string, passwordHash: string|null, passwordSalt: string|null }} user
   * @param {string} plaintext
   * @returns {Promise<boolean>} whether the password was correct
   */
  static async verifyAndUpgrade(user, plaintext) {
    if (!user || !user.passwordHash) return false;

    const isValid = await verifyPassword(plaintext, user.passwordHash, user.passwordSalt);
    if (!isValid) return false;

    if (needsRehash(user.passwordHash)) {
      try {
        const upgraded = await hashPassword(plaintext);
        await prisma.user.update({
          where: { id: user.id },
          data: { passwordHash: upgraded, passwordSalt: null },
        });
      } catch (error) {
        // Log and swallow: the login itself succeeded.
        console.error('Password rehash failed (login still succeeded):', error?.message);
      }
    }

    return true;
  }

  static async findUserByEmail(email) {
    return prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        name: true,
        tenantId: true,
        passwordHash: true,
        passwordSalt: true,
        provider: true,
        providerId: true,
      },
    });
  }

  static async createUser({ email, password, name, tenantId, provider = 'credentials', providerId = null, role = 'member' }, tx = prisma) {
    let passwordHash = null;
    let passwordSalt = null;

    if (password) {
      const { hash, salt } = await this.hashPassword(password);
      passwordHash = hash;
      passwordSalt = salt;
    }

    return tx.user.create({
      data: {
        email,
        name,
        tenantId,
        passwordHash,
        passwordSalt,
        provider,
        providerId,
        role,
        relationshipType: 'SELF', // Added default relationshipType
        preferredLocale: 'en_US', // Added default locale
      },
    });
  }

  static async findOrCreateGoogleUser({ email, name, googleId }) {
    const existingUser = await this.findUserByEmail(email);

    if (existingUser) {
      // If user exists but doesn't have Google provider, link their account
      if (existingUser.provider !== 'google') {
        const user = await prisma.user.update({
          where: { id: existingUser.id },
          data: {
            provider: 'google',
            providerId: googleId,
          },
        });
        return { user, isNew: false };
      }
      return { user: existingUser, isNew: false };
    }

    // Create new tenant, user, and seed default categories in a transaction
    const { tenant, user } = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: `${name}'s Workspace`,
          plan: 'FREE',
          plaidHistoryDays: parseInt(process.env.PLAID_HISTORY_DAYS ?? '1', 10),
        },
      });

      // Create new user with Google credentials.
      // This path creates a brand-new tenant, so the user is the tenant owner — grant admin.
      const user = await this.createUser({
        email,
        name,
        tenantId: tenant.id,
        provider: 'google',
        providerId: googleId,
        role: 'admin',
      }, tx);

      // Seed default categories for the new tenant
      await tx.category.createMany({
        data: DEFAULT_CATEGORIES.map(cat => ({
          name: cat.name,
          group: cat.group,
          type: cat.type,
          icon: cat.icon || null,
          processingHint: cat.processingHint || null,
          portfolioItemKeyStrategy: cat.portfolioItemKeyStrategy || 'IGNORE',
          defaultCategoryCode: cat.code ?? null,
          tenantId: tenant.id,
        })),
        skipDuplicates: true,
      });

      return { tenant, user };
    });

    return { user, isNew: true };
  }
} 