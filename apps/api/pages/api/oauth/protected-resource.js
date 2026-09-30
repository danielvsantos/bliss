import { StatusCodes } from 'http-status-codes';
import { publicCors, limit } from '../../../lib/oauthHttp.js';
import { SCOPES_SUPPORTED, issuerUrl, mcpResourceUrl } from '../../../utils/oauth.js';

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP endpoint (#89).
 * Served at /.well-known/oauth-protected-resource[/api/mcp] via next.config
 * rewrites; /api/mcp's 401 challenge points here.
 */
export default async function handler(req, res) {
  if (publicCors(req, res)) return;
  await limit(req, res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(StatusCodes.OK).json({
    resource: mcpResourceUrl(),
    authorization_servers: [issuerUrl()],
    scopes_supported: SCOPES_SUPPORTED,
    bearer_methods_supported: ['header'],
    resource_name: 'Bliss',
  });
}
