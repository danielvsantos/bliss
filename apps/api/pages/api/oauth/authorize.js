import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { limit } from '../../../lib/oauthHttp.js';
import { AuthorizeError, createAuthorizationRequest } from '../../../services/oauth.service.js';
import { frontendUrl, issuerUrl, withParams } from '../../../utils/oauth.js';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function errorPage(res, message) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(StatusCodes.BAD_REQUEST).send(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bliss — connection error</title></head>`
    + `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#3A3542">`
    + `<h1 style="font-size:1.25rem">This app can't connect to Bliss</h1><p>${escapeHtml(message)}</p>`
    + `<p>Remove the connector in your app and add it again.</p></body></html>`,
  );
}

/**
 * OAuth authorization endpoint (#89). Validates the request, stores it, and
 * sends the browser to the Bliss web app's consent page, which handles
 * sign-in. Unknown clients / redirect URIs get an error page, never a redirect.
 */
export default async function handler(req, res) {
  await limit(req, res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).json({ error: 'Method not allowed' });
  }
  try {
    const requestId = await createAuthorizationRequest(req.query || {});
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Location', `${frontendUrl()}/oauth/consent?request=${encodeURIComponent(requestId)}`);
    return res.status(StatusCodes.MOVED_TEMPORARILY).end();
  } catch (err) {
    if (err instanceof AuthorizeError) {
      if (!err.redirect) return errorPage(res, err.description || err.error);
      const q = req.query || {};
      const one = (v) => (Array.isArray(v) ? v[0] : v);
      res.setHeader('Location', withParams(String(one(q.redirect_uri)), {
        error: err.error, error_description: err.description, state: one(q.state), iss: issuerUrl(),
      }));
      return res.status(StatusCodes.MOVED_TEMPORARILY).end();
    }
    Sentry.captureException(err);
    return errorPage(res, 'Something went wrong on the Bliss server.');
  }
}
