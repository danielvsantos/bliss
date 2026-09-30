import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../../../utils/cors.js';
import { withAuth } from '../../../../../utils/withAuth.js';
import { limit } from '../../../../../lib/oauthHttp.js';
import { denyRequest, loadRequestForUser } from '../../../../../services/oauth.service.js';

/** Deny a pending OAuth request (#89): returns the client redirect with access_denied. */
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
    const denied = await denyRequest(result.request, req.user);
    return res.status(StatusCodes.OK).json({ redirectUrl: denied.redirectUrl });
  } catch (err) {
    Sentry.captureException(err);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Server Error' });
  }
});
