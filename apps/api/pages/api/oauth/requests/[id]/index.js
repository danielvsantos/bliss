import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../../../utils/cors.js';
import { withAuth } from '../../../../../utils/withAuth.js';
import { limit } from '../../../../../lib/oauthHttp.js';
import { loadRequestForUser, serializeConsent } from '../../../../../services/oauth.service.js';

/**
 * Consent page data for a pending OAuth request (#89). Signed-in Bliss users
 * only (integration tokens are denylisted on /api/oauth). The first user to
 * open a request is bound to it.
 */
export default withAuth(async function handler(req, res) {
  await limit(req, res);
  if (cors(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }
  try {
    const result = await loadRequestForUser(req.query.id, req.user);
    if (!result.request) return res.status(result.status).json({ error: result.error });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(StatusCodes.OK).json(serializeConsent(result.request, req.user));
  } catch (err) {
    Sentry.captureException(err);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Server Error' });
  }
});
