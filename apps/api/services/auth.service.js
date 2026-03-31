import { randomBytes, pbkdf2Sync } from 'crypto';
import prisma from '../prisma/prisma';
import { DEFAULT_CATEGORIES } from '../lib/defaultCategories.js';

export class AuthService {
  static async hashPassword(password) {
    const salt = randomBytes(16).toString('hex');
    const hash = pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return { hash, salt };
  }

  static async verifyPassword(password, hash, salt) {
    const verifyHash = pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return verifyHash === hash;
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