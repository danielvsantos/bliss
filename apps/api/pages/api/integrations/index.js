import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../prisma/prisma.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { cors } from '../../../utils/cors.js';
import { withAuth } from '../../../utils/withAuth.js';
import {
  API_KEY_PUBLIC_SELECT,
  OAUTH_CLIENT_INCLUDE,
  buildApiKey,
  serializeApiKey,
  serializeIntegration,
  validateCreateIntegration,
} from '../../../services/integrations.service.js';

/**
 * Integrations & API tokens (#84) — tenant admin only.
 *
 * GET  /api/integrations
 *   → 200 { integrations: [...] } with key metadata (never hashes or tokens).
 *
 * POST /api/integrations
 *   Body: { name, description?, accessLevel: 'READ_ONLY'|'READ_WRITE',
 *           key: { name?, expiresInDays: 30|90|365|null } }
 *   → 201 { integration, apiKey, token } — `token` is the only time the
 *     plaintext is ever returned.
 *
 * Integration tokens themselves are refused here by the withAuth denylist.
 */
export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.integrations(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  const { tenantId, id: userId } = req.user;

  try {
    if (req.method === 'GET') {
      const integrations = await prisma.integration.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        include: {
          apiKeys: { select: API_KEY_PUBLIC_SELECT, orderBy: { createdAt: 'asc' } },
          oauthClient: OAUTH_CLIENT_INCLUDE,
        },
      });
      const now = new Date();
      return res.status(StatusCodes.OK).json({
        integrations: integrations.map((i) => serializeIntegration(i, now)),
      });
    }

    if (req.method === 'POST') {
      const parsed = validateCreateIntegration(req.body);
      if (!parsed.ok) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: parsed.error });
      }
      const { name, description, accessLevel, key } = parsed.value;
      const { data: keyData, token } = buildApiKey({ tenantId, ...key });

      const integration = await prisma.integration.create({
        data: {
          tenantId,
          name,
          description,
          accessLevel,
          createdByUserId: userId,
          apiKeys: { create: keyData },
        },
        include: { apiKeys: { select: API_KEY_PUBLIC_SELECT } },
      });

      return res.status(StatusCodes.CREATED).json({
        integration: serializeIntegration(integration),
        apiKey: serializeApiKey(integration.apiKeys[0]),
        token,
      });
    }

    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).json({ error: `Method ${req.method} Not Allowed` });
  } catch (error) {
    Sentry.captureException(error);
    console.error('integrations: request failed', { message: error?.message });
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Internal server error' });
  }
}, { requireRole: 'admin' });
