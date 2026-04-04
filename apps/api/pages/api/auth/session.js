import prisma from '../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../utils/cors.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { withAuth } from '../../../utils/withAuth.js';

export default withAuth(async function handler(req, res) {
  // Apply rate limiting
  await new Promise((resolve, reject) => {
    rateLimiters.session(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });
  if (cors(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
    return;
  }
  try {
    const fullUser = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, name: true, profilePictureUrl: true, provider: true, role: true, tenant: true }
    });
    if (!fullUser) return res.status(404).json({ error: 'User not found' });
    return res.status(200).json({
      user: { id: fullUser.id, email: fullUser.email, name: fullUser.name, role: fullUser.role, tenant: fullUser.tenant, profilePictureUrl: fullUser.profilePictureUrl, provider: fullUser.provider }
    });
  } catch (error) {
    console.error('Session check error:', error);
    return res.status(500).json({ error: 'Failed to retrieve session' });
  }
});