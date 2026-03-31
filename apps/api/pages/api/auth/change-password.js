import prisma from '../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { AuthService } from '../../../services/auth.service';
import { cors } from '../../../utils/cors.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { withAuth } from '../../../utils/withAuth.js';

export default withAuth(async function handler(req, res) {
  // Apply rate limiting
  await new Promise((resolve, reject) => {
    rateLimiters.changePassword(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  // Handle CORS
  if (cors(req, res)) return;

  if (req.method !== 'PUT') {
    res.setHeader('Allow', ['PUT']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
    return;
  }

  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    // Validate required fields
    if (!currentPassword || !newPassword || !confirmPassword) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'All password fields are required' });
      return;
    }

    // Validate new password length
    if (newPassword.length < 8) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'New password must be at least 8 characters' });
      return;
    }

    // Validate passwords match
    if (newPassword !== confirmPassword) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'New password and confirmation do not match' });
      return;
    }

    // Fetch user credentials
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { passwordHash: true, passwordSalt: true },
    });

    if (!user || !user.passwordHash) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Password change is not available for this account' });
      return;
    }

    // Verify current password
    const isValid = await AuthService.verifyPassword(
      currentPassword,
      user.passwordHash,
      user.passwordSalt
    );

    if (!isValid) {
      res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Current password is incorrect' });
      return;
    }

    // Hash new password and update
    const { hash, salt } = await AuthService.hashPassword(newPassword);

    await prisma.user.update({
      where: { id: req.user.id },
      data: { passwordHash: hash, passwordSalt: salt },
    });

    res.status(StatusCodes.OK).json({ message: 'Password updated successfully' });
    return;

  } catch (error) {
    console.error('Change password error:', error);
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to change password',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
