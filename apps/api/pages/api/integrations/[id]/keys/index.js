import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../../../prisma/prisma.js';
import { rateLimiters } from '../../../../../utils/rateLimit.js';
import { cors } from '../../../../../utils/cors.js';
import { withAuth } from '../../../../../utils/withAuth.js';
import {
  API_KEY_PUBLIC_SELECT,
  buildApiKey,
  serializeApiKey,
  validateKeyInput,
} from '../../../../../services/integrations.service.js';

/**
 * Integrations & API tokens (#84) — tenant admin only.
 *
 * POST /api/integrations/:id/keys   Body: { name?, expiresInDays: 30|90|365|null }
 *   → 201 { apiKey, token } — the plaintext token is returned this once.
 *   → 409 INTEGRATION_REVOKED on a revoked integration; 409 OAUTH_MANAGED on an
 *     OAuth connection (#89), whose key is managed by the token endpoint.
 *
 * Several active keys per integration allow zero-downtime rotation.
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
    if (req.method !== 'POST') {
      res.setHeader('Allow', ['POST']);
      return res.status(StatusCodes.METHOD_NOT_ALLOWED).json({ error: `Method ${req.method} Not Allowed` });
    }

    const integration = typeof id === 'string'
      ? await prisma.integration.findFirst({ where: { id, tenantId } })
      : null;
    if (!integration) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: 'Integration not found' });
    }
    if (integration.revokedAt) {
      return res.status(StatusCodes.CONFLICT).json({
        error: 'This integration has been revoked',
        code: 'INTEGRATION_REVOKED',
      });
    }
    // OAuth connections (#89) have exactly one key, re-keyed by the token endpoint.
    if (integration.oauthClientId) {
      return res.status(StatusCodes.CONFLICT).json({
        error: 'Keys for an OAuth connection are managed by the connected app',
        code: 'OAUTH_MANAGED',
      });
    }

    const parsed = validateKeyInput(req.body);
    if (!parsed.ok) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: parsed.error });
    }

    const { data, token } = buildApiKey({ tenantId, integrationId: integration.id, ...parsed.value });
    const apiKey = await prisma.apiKey.create({ data, select: API_KEY_PUBLIC_SELECT });

    return res.status(StatusCodes.CREATED).json({ apiKey: serializeApiKey(apiKey), token });
  } catch (error) {
    Sentry.captureException(error);
    console.error('integrations/[id]/keys: request failed', { message: error?.message });
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Internal server error' });
  }
}, { requireRole: 'admin' });
