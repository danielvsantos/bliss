import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { publicCors, limit, oauthError } from '../../../lib/oauthHttp.js';
import { OAuthError, registerClient } from '../../../services/oauth.service.js';

/**
 * Dynamic Client Registration (RFC 7591) for MCP clients (#89). Public
 * clients only; redirect URIs must use an allowlisted host
 * (OAUTH_ALLOWED_REDIRECT_HOSTS, default claude.ai, claude.com, Google's
 * oauth-redirect[-sandbox|-test].googleusercontent.com relays for Gemini, localhost).
 */
export default async function handler(req, res) {
  if (publicCors(req, res)) return;
  await limit(req, res, 'oauthRegister');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).json({ error: 'Method not allowed' });
  }
  try {
    const client = await registerClient(req.body && typeof req.body === 'object' ? req.body : {});
    res.setHeader('Cache-Control', 'no-store');
    return res.status(StatusCodes.CREATED).json(client);
  } catch (err) {
    if (err instanceof OAuthError) return oauthError(res, err);
    Sentry.captureException(err);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'server_error' });
  }
}
