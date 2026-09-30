import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../prisma/prisma.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { cors } from '../../../utils/cors.js';
import { withAuth } from '../../../utils/withAuth.js';
import {
  API_KEY_PUBLIC_SELECT,
  OAUTH_CLIENT_INCLUDE,
  serializeIntegration,
  validateUpdateIntegration,
} from '../../../services/integrations.service.js';

/**
 * Integrations & API tokens (#84) — tenant admin only.
 *
 * PATCH  /api/integrations/:id   Body: { name?, description? }
 *   → 200 { integration }. `accessLevel` → 400 ACCESS_LEVEL_IMMUTABLE.
 *
 * DELETE /api/integrations/:id
 *   → 200 { integration } — stamps revokedAt on the integration and every key
 *     (idempotent). Revoked keys stop working on the next request.
 *
 * Another tenant's id → 404.
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
  const { id } = req.query;

  try {
    if (req.method !== 'PATCH' && req.method !== 'DELETE') {
      res.setHeader('Allow', ['PATCH', 'DELETE']);
      return res.status(StatusCodes.METHOD_NOT_ALLOWED).json({ error: `Method ${req.method} Not Allowed` });
    }

    const existing = typeof id === 'string'
      ? await prisma.integration.findFirst({ where: { id, tenantId } })
      : null;
    if (!existing) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: 'Integration not found' });
    }

    if (req.method === 'PATCH') {
      const parsed = validateUpdateIntegration(req.body);
      if (!parsed.ok) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: parsed.error, ...(parsed.code && { code: parsed.code }) });
      }
      const integration = await prisma.integration.update({
        where: { id: existing.id },
        data: parsed.value,
        include: { apiKeys: { select: API_KEY_PUBLIC_SELECT, orderBy: { createdAt: 'asc' } }, oauthClient: OAUTH_CLIENT_INCLUDE },
      });
      return res.status(StatusCodes.OK).json({ integration: serializeIntegration(integration) });
    }

    // DELETE → revoke (idempotent)
    const now = new Date();
    const [, integration] = await prisma.$transaction([
      prisma.apiKey.updateMany({
        where: { integrationId: existing.id, tenantId, revokedAt: null },
        data: { revokedAt: now },
      }),
      prisma.integration.update({
        where: { id: existing.id },
        data: { revokedAt: existing.revokedAt ?? now },
        include: { apiKeys: { select: API_KEY_PUBLIC_SELECT, orderBy: { createdAt: 'asc' } }, oauthClient: OAUTH_CLIENT_INCLUDE },
      }),
    ]);
    return res.status(StatusCodes.OK).json({ integration: serializeIntegration(integration) });
  } catch (error) {
    Sentry.captureException(error);
    console.error('integrations/[id]: request failed', { message: error?.message });
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Internal server error' });
  }
}, { requireRole: 'admin' });
