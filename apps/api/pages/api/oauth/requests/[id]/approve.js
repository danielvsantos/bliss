import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../../../utils/cors.js';
import { withAuth } from '../../../../../utils/withAuth.js';
import { limit } from '../../../../../lib/oauthHttp.js';
import { OAuthError, approveRequest, loadRequestForUser } from '../../../../../services/oauth.service.js';

/**
 * Approve a pending OAuth request (#89) — tenant admins only, like creating an
 * integration (#84). Body: { accessLevel, expiresInDays }. Creates the
 * Integration and returns the client redirect URL carrying a one-time code.
 */
export default withAuth(async function handler(req, res) {
  await limit(req, res);
  if (cors(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }
  try {
    const result = await loadRequestForUser(req.query.id, req.user);
    if (!result.request) return res.status(result.status).json({ error: result.error });
    const { accessLevel, expiresInDays = 90 } = req.body || {};
    const approved = await approveRequest(result.request, req.user, { accessLevel, expiresInDays });
    return res.status(StatusCodes.OK).json({ redirectUrl: approved.redirectUrl });
  } catch (err) {
    if (err instanceof OAuthError) return res.status(StatusCodes.BAD_REQUEST).json({ error: err.description || err.error });
    Sentry.captureException(err);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Server Error' });
  }
}, { requireRole: 'admin' });
