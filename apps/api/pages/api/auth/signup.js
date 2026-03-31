import prisma from '../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { AuthService } from '../../../services/auth.service';
import { cors } from '../../../utils/cors.js';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { DEFAULT_CATEGORIES } from '../../../lib/defaultCategories.js';
import { setAuthCookie } from '../../../utils/cookieUtils.js';

const JWT_SECRET = process.env.JWT_SECRET_CURRENT || process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET_CURRENT or JWT_SECRET must be set in environment variables');
}
const TOKEN_EXPIRY = '24h';

export default async function handler(req, res) {
  // Apply rate limiting
  await new Promise((resolve, reject) => {
    rateLimiters.signup(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  // Handle CORS
  if (cors(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
    return;
  }

  const { email, password, name, tenantName, countries, currencies, bankIds } = req.body;

  // --- Start Validation ---
  if (!email || !password || !tenantName) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Email, password, and tenantName are required' });
    return;
  }
  if (password.length < 8) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Password must be at least 8 characters long' });
    return;
  }
  // --- End Validation ---

  try {
    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid email format' });
      return;
    }

    // Check if user already exists - use the encrypted email search
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      res.status(StatusCodes.CONFLICT).json({ error: 'User with this email already exists' });
      return;
    }

    // If countries and currencies are provided, validate them
    let validCountries = [];
    let validCurrencies = [];
    let validBanks = [];

    if (countries.length > 0 || currencies.length > 0) {
      // Normalize and deduplicate codes
      const uniqueCountries = [...new Set(countries.map(c => c.toUpperCase()))];
      const uniqueCurrencies = [...new Set(currencies.map(c => c.toUpperCase()))];

      // Validate countries and currencies
      [validCountries, validCurrencies] = await Promise.all([
        prisma.country.findMany({
          where: { id: { in: uniqueCountries } }
        }),
        prisma.currency.findMany({
          where: { id: { in: uniqueCurrencies } }
        })
      ]);

      // Check for invalid codes
      const invalidCountries = uniqueCountries.filter(
        code => !validCountries.find(c => c.id === code)
      );
      const invalidCurrencies = uniqueCurrencies.filter(
        code => !validCurrencies.find(c => c.id === code)
      );

      if (invalidCountries.length > 0 || invalidCurrencies.length > 0) {
        res.status(StatusCodes.BAD_REQUEST).json({
          error: 'Invalid country or currency codes',
          details: {
            invalidCountries: invalidCountries.length > 0 ? invalidCountries : null,
            invalidCurrencies: invalidCurrencies.length > 0 ? invalidCurrencies : null
          }
        });
        return;
      }
    }

    // Validate Bank IDs if provided
    if (bankIds.length > 0) {
      const uniqueBankIds = [...new Set(bankIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id)))];
      if (uniqueBankIds.length !== bankIds.length) {
        res.status(StatusCodes.BAD_REQUEST).json({ 
          error: 'Invalid bankId format. Must be integers.'
        });
        return;
      }
      validBanks = await prisma.bank.findMany({ 
        where: { id: { in: uniqueBankIds } } 
      });

      const invalidBankIds = uniqueBankIds.filter(id => !validBanks.find(b => b.id === id));
      if (invalidBankIds.length > 0) {
        res.status(StatusCodes.BAD_REQUEST).json({
          error: 'Invalid bank IDs',
          details: { invalidBankIds }
        });
        return;
      }
    }

    // Get preferred locale from Accept-Language header
    const acceptLanguage = req.headers['accept-language'] || 'en-US';
    const preferredLocale = acceptLanguage.split(',')[0].replace(/-/g, '_');
    
    // Create everything in a transaction
    const { user, tenant, token } = await prisma.$transaction(async (tx) => {
      // First create the tenant
      const tenant = await tx.tenant.create({
        data: {
          name: tenantName,
          plan: 'FREE',
          plaidHistoryDays: parseInt(process.env.PLAID_HISTORY_DAYS ?? '1', 10),
        }
      });

      // Then create the user using the AuthService.
      // The first user in a new tenant is always the owner — grant admin role.
      const user = await AuthService.createUser({
        email,
        password,
        name,
        tenantId: tenant.id,
        role: 'admin',
      }, tx);

      // Create relationships if provided
      if (validCountries.length > 0) {
        await tx.tenantCountry.createMany({
          data: validCountries.map((country, index) => ({
            tenantId: tenant.id,
            countryId: country.id,
            isDefault: index === 0
          }))
        });
      }

      if (validCurrencies.length > 0) {
        await tx.tenantCurrency.createMany({
          data: validCurrencies.map((currency, index) => ({
            tenantId: tenant.id,
            currencyId: currency.id,
            isDefault: index === 0
          }))
        });
      }

      if (validBanks.length > 0) {
        await tx.tenantBank.createMany({
          data: validBanks.map(bank => ({
            tenantId: tenant.id,
            bankId: bank.id
          }))
        });
      }

      // Seed default categories for the new tenant
      await tx.category.createMany({
        data: DEFAULT_CATEGORIES.map(cat => ({
          name: cat.name,
          group: cat.group,
          type: cat.type,
          icon: cat.icon || null,
          processingHint: cat.processingHint || null,
          portfolioItemKeyStrategy: cat.portfolioItemKeyStrategy || 'IGNORE',
          defaultCategoryCode: cat.code ?? null, // Sprint B: stable cross-tenant identifier
          tenantId: tenant.id,
        })),
        skipDuplicates: true,
      });

      // Create audit log
      await tx.auditLog.create({
        data: {
          userId: email, // Use unencrypted email for audit log
          action: "CREATE",
          table: "Tenant",
          recordId: tenant.id.toString(),
          tenantId: tenant.id
        }
      });

      // Generate JWT token with a unique ID for revocation support
      const token = jwt.sign(
        {
          jti: uuidv4(),
          userId: user.id,
          email: user.email, // This will be the decrypted email from the middleware
          tenantId: tenant.id
        },
        JWT_SECRET,
        { expiresIn: TOKEN_EXPIRY }
      );

      return { user, tenant, token };
    });

    // To ensure consistency with the signin response, nest tenant within user
    const userWithTenant = { ...user, tenant };

    // Set HttpOnly cookie and return user info (no token in body)
    setAuthCookie(res, token);
    res.status(StatusCodes.CREATED).json({
      message: "Signup successful",
      user: userWithTenant,
    });
    return;

  } catch (error) {
    console.error('Signup error:', error);
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Signup failed',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
} 