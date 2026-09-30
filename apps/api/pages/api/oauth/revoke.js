import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { publicCors, limit, oauthError, formBody } from '../../../lib/oauthHttp.js';
import { OAuthError, revokeToken } from '../../../services/oauth.service.js';

/**
 * OAuth token revocation (RFC 7009) (#89). Revoking either token ends the
 * whole connection (the Integration, its key and its refresh tokens).
 * Unknown tokens answer 200, as the RFC requires.
 */
export default async function handler(req, res) {
  if (publicCors(req, res)) return;
  await limit(req, res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');
  try {
    await revokeToken(formBody(req));
    return res.status(StatusCodes.OK).json({});
  } catch (err) {
    if (err instanceof OAuthError) return oauthError(res, err);
    Sentry.captureException(err);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'server_error' });
  }
}
