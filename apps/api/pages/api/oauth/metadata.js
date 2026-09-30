import { StatusCodes } from 'http-status-codes';
import { publicCors, limit } from '../../../lib/oauthHttp.js';
import { SCOPES_SUPPORTED, issuerUrl } from '../../../utils/oauth.js';

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414) (#89). Served at
 * /.well-known/oauth-authorization-server[/api/mcp] via next.config rewrites.
 */
export default async function handler(req, res) {
  if (publicCors(req, res)) return;
  await limit(req, res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).json({ error: 'Method not allowed' });
  }
  const issuer = issuerUrl();
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(StatusCodes.OK).json({
    issuer,
    authorization_endpoint: `${issuer}/api/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    registration_endpoint: `${issuer}/api/oauth/register`,
    revocation_endpoint: `${issuer}/api/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: SCOPES_SUPPORTED,
    authorization_response_iss_parameter_supported: true,
  });
}
