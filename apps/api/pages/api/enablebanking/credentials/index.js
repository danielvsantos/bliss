/**
 * Per-tenant Enable Banking credentials (#148) — tenant admin only.
 *
 * GET    /api/enablebanking/credentials
 *   → 200 { configured, callbackUrl, credential, usage, history }. The private
 *     key is write-only and never part of any response.
 * PUT    /api/enablebanking/credentials
 *   Body: { appId (UUID), privateKey (PEM, ≤ 16 KB), confirmAppChange? }
 *   → 201 (first Set) / 200 with the GET payload
 *   → 400 INVALID_APP_ID | KEY_* format errors (nothing stored)
 *   → 409 CONFIRMATION_REQUIRED { affectedConnections } (app change, live connections)
 *   → 422 INVALID_CREDENTIALS | SANDBOX_APP (Enable Banking rejected them; nothing stored)
 * DELETE /api/enablebanking/credentials?confirm=true
 *   → 204; 409 CONFIRMATION_REQUIRED without `confirm` when connections exist;
 *     404 NOT_CONFIGURED.
 *
 * Integration tokens are refused by the /api/enablebanking denylist entry.
 * Errors are reported to Sentry without the request body.
 */

import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { rateLimiters } from '../../../../utils/rateLimit.js';
import { withAuth } from '../../../../utils/withAuth.js';
import {
  CredentialError,
  loadCredentialsView,
  removeCredentials,
  saveCredentials,
} from '../../../../services/enableBankingCredentials.service.js';

export const config = { api: { bodyParser: { sizeLimit: '32kb' } } };

export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.enableBankingCredentials(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  const { tenantId, id: userId } = req.user;

  try {
    if (req.method === 'GET') {
      return res.status(StatusCodes.OK).json(await loadCredentialsView(tenantId));
    }

    if (req.method === 'PUT') {
      const { created } = await saveCredentials({ tenantId, userId, body: req.body });
      return res.status(created ? StatusCodes.CREATED : StatusCodes.OK).json(await loadCredentialsView(tenantId));
    }

    if (req.method === 'DELETE') {
      await removeCredentials({ tenantId, userId, confirm: req.query.confirm === 'true' });
      return res.status(StatusCodes.NO_CONTENT).end();
    }

    res.setHeader('Allow', ['GET', 'PUT', 'DELETE']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  } catch (error) {
    if (error instanceof CredentialError) return res.status(error.status).json(error.body);
    // Never pass the request as context: its body carries the private key.
    Sentry.captureException(error);
    console.error('[enablebanking/credentials] failed:', error.message);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Server Error' });
  }
}, { requireRole: 'admin' });
