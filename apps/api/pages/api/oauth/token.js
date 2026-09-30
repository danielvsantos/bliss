import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { publicCors, limit, oauthError, formBody } from '../../../lib/oauthHttp.js';
import { OAuthError, exchangeAuthorizationCode, refreshAccessToken } from '../../../services/oauth.service.js';

/**
 * OAuth token endpoint (#89): authorization_code (PKCE S256) and rotating
 * refresh_token grants for public clients. The access token is a Bliss
 * integration key (#84).
 */
export default async function handler(req, res) {
  if (publicCors(req, res)) return;
  await limit(req, res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  const body = formBody(req);
  try {
    let tokens;
    if (body.grant_type === 'authorization_code') tokens = await exchangeAuthorizationCode(body);
    else if (body.grant_type === 'refresh_token') tokens = await refreshAccessToken(body);
    else throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
    return res.status(StatusCodes.OK).json(tokens);
  } catch (err) {
    if (err instanceof OAuthError) return oauthError(res, err);
    Sentry.captureException(err);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'server_error' });
  }
}
