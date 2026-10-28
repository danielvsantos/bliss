import prisma from '../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { AuthService } from '../../../services/auth.service';
import { cors } from '../../../utils/cors.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { normalizeEmail } from '../../../utils/normalizeEmail.js';
import { startSession } from '../../../services/session.service.js';

// Simple email validation regex
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  // Apply rate limiting
  await new Promise((resolve, reject) => {
    rateLimiters.signin(req, res, (result) => {
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

  try {
    const { email, password } = req.body;

    // Validate required fields
    if (!email || !password) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Email and password are required' });
      return;
    }

    // Normalize BEFORE validating: the regex rejects surrounding whitespace,
    // so a pasted "  a@b.com " would otherwise be reported as malformed.
    // Also required for the lookup itself — User.email is deterministically
    // encrypted, so the ciphertext derives from the exact plaintext and a
    // mixed-case address would simply not match the stored row.
    const normalizedEmail = normalizeEmail(email);

    // Validate email format
    if (!emailRegex.test(normalizedEmail)) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid email format' });
      return;
    }

    // Find user by email - encryption handled by Prisma middleware.
    const user = await prisma.user.findFirst({
      where: { email: normalizedEmail },
      include: {
        tenant: true
      }
    });

    if (!user) {
      res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Invalid credentials' });
      return;
    }

    // OAuth-only accounts have no password set — reject gracefully instead of
    // crashing. Note: only passwordHash is checked. passwordSalt is null for
    // every scrypt-format row, so requiring it here would lock out every user
    // the moment their hash is upgraded.
    if (!user.passwordHash) {
      res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Invalid credentials' });
      return;
    }

    // Verifies against both storage formats and transparently upgrades a
    // legacy PBKDF2-1,000 hash to scrypt on success.
    const isValidPassword = await AuthService.verifyAndUpgrade(user, password);

    if (!isValidPassword) {
      res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Invalid credentials' });
      return;
    }

    // Start a session (#156): 15-min access cookie + rotating refresh cookie.
    // No token in the body.
    await startSession(res, { id: user.id, tenantId: user.tenant.id, email: user.email }, req);
    res.status(StatusCodes.OK).json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        tenant: {
          id: user.tenant.id,
          name: user.tenant.name
        },
        profilePictureUrl: user.profilePictureUrl,
      }
    });
    return;

  } catch (error) {
    console.error('Signin error:', error);
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Authentication failed',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
} 