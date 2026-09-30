/**
 * OAuth discovery rewrites for the MCP server (#89): RFC 9728 / RFC 8414
 * documents at the root and path-insertion (`/…/api/mcp`) locations MCP
 * clients probe. Used by next.config.mjs and by the test HTTP harness.
 */
export const OAUTH_REWRITES = [
  { source: '/.well-known/oauth-protected-resource', destination: '/api/oauth/protected-resource' },
  { source: '/.well-known/oauth-protected-resource/:path*', destination: '/api/oauth/protected-resource' },
  { source: '/.well-known/oauth-authorization-server', destination: '/api/oauth/metadata' },
  { source: '/.well-known/oauth-authorization-server/:path*', destination: '/api/oauth/metadata' },
];
