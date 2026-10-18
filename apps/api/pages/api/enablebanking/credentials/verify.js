/**
 * POST /api/enablebanking/credentials/verify (#148) — tenant admin only.
 *
 * Re-runs the GET /application probe with the stored credentials:
 * VERIFIED clears an earlier INVALID mark, a rejection marks them INVALID,
 * an unreachable Enable Banking leaves them UNVERIFIED. No history entry.
 * → 200 with the GET /api/enablebanking/credentials payload; 404 NOT_CONFIGURED.
 */

import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { rateLimiters } from '../../../../utils/rateLimit.js';
import { withAuth } from '../../../../utils/withAuth.js';
import {
  CredentialError,
  loadCredentialsView,
  reverifyCredentials,
} from '../../../../services/enableBankingCredentials.service.js';

export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.enableBankingCredentials(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  try {
    await reverifyCredentials(req.user.tenantId);
    return res.status(StatusCodes.OK).json(await loadCredentialsView(req.user.tenantId));
  } catch (error) {
    if (error instanceof CredentialError) return res.status(error.status).json(error.body);
    Sentry.captureException(error);
    console.error('[enablebanking/credentials/verify] failed:', error.message);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Server Error' });
  }
}, { requireRole: 'admin' });
