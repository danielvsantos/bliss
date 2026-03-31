import prisma from '../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { AuthService } from '../../../services/auth.service';
import { cors } from '../../../utils/cors.js';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { setAuthCookie } from '../../../utils/cookieUtils.js';

const JWT_SECRET = process.env.JWT_SECRET_CURRENT || process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET_CURRENT or JWT_SECRET must be set in environment variables');
}
const TOKEN_EXPIRY = '24h';

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

    // Validate email format
    if (!emailRegex.test(email)) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid email format' });
      return;
    }

    // Find user by email - encryption handled by Prisma middleware
    const user = await prisma.user.findFirst({
      where: { email },
      include: {
        tenant: true
      }
    });

    if (!user) {
      res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Invalid credentials' });
      return;
    }

    // Verify password using AuthService
    const isValidPassword = await AuthService.verifyPassword(
      password,
      user.passwordHash,
      user.passwordSalt
    );

    if (!isValidPassword) {
      res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Invalid credentials' });
      return;
    }

    // Generate JWT token with a unique ID for revocation support
    const token = jwt.sign(
      {
        jti: uuidv4(),
        userId: user.id,
        tenantId: user.tenant.id,
        email: user.email
      },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRY }
    );

    // Set HttpOnly cookie and return user info (no token in body)
    setAuthCookie(res, token);
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