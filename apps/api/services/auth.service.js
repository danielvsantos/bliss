import prisma from '../prisma/prisma';
import { DEFAULT_CATEGORIES } from '../lib/defaultCategories.js';
import { hashPassword, verifyPassword, needsRehash } from './password.js';
import { normalizeEmail } from '../utils/normalizeEmail.js';

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
    // User.email is deterministically encrypted, so the ciphertext derives from
    // the exact plaintext bytes. Lookups must use the same canonical form the
    // row was written with, or a mixed-case address simply will not be found.
    return prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
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
        email: normalizeEmail(email),
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

  /**
   * Error codes thrown by findOrCreateGoogleUser. The NextAuth signIn callback
   * maps each to a distinct `?error=` code so the auth page can explain what
   * happened instead of showing a generic failure.
   */
  static GOOGLE_EMAIL_UNVERIFIED = 'GOOGLE_EMAIL_UNVERIFIED';
  static GOOGLE_ACCOUNT_EXISTS = 'GOOGLE_ACCOUNT_EXISTS';

  /**
   * Sign in with Google: return the existing Google-linked user, or create a
   * brand-new Tenant + User.
   *
   * Two things this deliberately does NOT do:
   *
   * 1. It does not trust an unverified email. Google returns `email_verified`
   *    on the profile; without checking it, anyone able to present a Google
   *    profile carrying a victim's address could claim that address.
   * 2. It does not implicitly convert an existing credentials account to a
   *    Google account. The previous behaviour was to absorb any account whose
   *    email matched — meaning a Google identity that had never proved control
   *    of that account took it over. Linking an existing password account to
   *    Google is a deliberate, authenticated action and is out of scope here;
   *    until it exists, this path rejects and the row is left untouched.
   *
   * @param {{ email: string, name: string, googleId: string, emailVerified: boolean }} profile
   * @returns {Promise<{ user: object, isNew: boolean }>}
   * @throws {Error} with `.code` set to one of the constants above.
   */
  static async findOrCreateGoogleUser({ email, name, googleId, emailVerified }) {
    if (emailVerified !== true) {
      const err = new Error('Google account email is not verified');
      err.code = AuthService.GOOGLE_EMAIL_UNVERIFIED;
      throw err;
    }

    const existingUser = await this.findUserByEmail(email);

    if (existingUser) {
      if (existingUser.provider !== 'google') {
        // Reject WITHOUT touching the row. The account is reachable by its
        // owner with their password; nothing about this request proves the
        // Google identity is that owner.
        const err = new Error(
          'An account with this email already exists. Sign in with your password instead.'
        );
        err.code = AuthService.GOOGLE_ACCOUNT_EXISTS;
        throw err;
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