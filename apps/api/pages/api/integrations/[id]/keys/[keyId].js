import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../../../prisma/prisma.js';
import { rateLimiters } from '../../../../../utils/rateLimit.js';
import { cors } from '../../../../../utils/cors.js';
import { withAuth } from '../../../../../utils/withAuth.js';
import { API_KEY_PUBLIC_SELECT, serializeApiKey } from '../../../../../services/integrations.service.js';

/**
 * Integrations & API tokens (#84) — tenant admin only.
 *
 * DELETE /api/integrations/:id/keys/:keyId
 *   → 200 { apiKey } — stamps revokedAt (idempotent). Other keys of the same
 *     integration keep working.
 *
 * A key of another tenant or another integration → 404.
 */
export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.integrations(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  const { tenantId } = req.user;
  const { id, keyId } = req.query;

  try {
    if (req.method !== 'DELETE') {
      res.setHeader('Allow', ['DELETE']);
      return res.status(StatusCodes.METHOD_NOT_ALLOWED).json({ error: `Method ${req.method} Not Allowed` });
    }

    const existing = typeof id === 'string' && typeof keyId === 'string'
      ? await prisma.apiKey.findFirst({
        where: { id: keyId, integrationId: id, tenantId },
        select: { id: true, revokedAt: true },
      })
      : null;
    if (!existing) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: 'API key not found' });
    }

    const apiKey = await prisma.apiKey.update({
      where: { id: existing.id },
      data: { revokedAt: existing.revokedAt ?? new Date() },
      select: API_KEY_PUBLIC_SELECT,
    });
    return res.status(StatusCodes.OK).json({ apiKey: serializeApiKey(apiKey) });
  } catch (error) {
    Sentry.captureException(error);
    console.error('integrations/[id]/keys/[keyId]: request failed', { message: error?.message });
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Internal server error' });
  }
}, { requireRole: 'admin' });
