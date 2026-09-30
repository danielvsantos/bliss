import crypto from 'crypto';
import { randomBase62 } from './apiKeys.js';

/**
 * OAuth 2.1 helpers for the MCP server (#89) — pure functions: configuration,
 * redirect-URI policy, PKCE, scopes and secret generation. Database work lives
 * in services/oauth.service.js. See docs/specs/api/25-oauth.md.
 */

export const REQUEST_TTL_MS = 10 * 60 * 1000;
export const CODE_TTL_MS = 60 * 1000;
export const ACCESS_TOKEN_TTL_S = 60 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_CONNECTION_DAYS = 90;
export const CONNECTION_EXPIRY_DAYS = [30, 90, 365, null];

export const SCOPE_READ = 'mcp:read';
export const SCOPE_WRITE = 'mcp:write';
export const SCOPES_SUPPORTED = [SCOPE_READ, SCOPE_WRITE];

export const REFRESH_TOKEN_PREFIX = 'bliss_rt_';

const DEFAULT_REDIRECT_HOSTS = ['claude.ai', 'claude.com', 'localhost', '127.0.0.1'];
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Public origin of the API: OAUTH_ISSUER_URL, else NEXTAUTH_URL's origin. */
export function issuerUrl() {
  const raw = process.env.OAUTH_ISSUER_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';
  try {
    return new URL(raw).origin;
  } catch {
    return 'http://localhost:3000';
  }
}

/** The protected resource: the MCP endpoint. */
export function mcpResourceUrl() {
  return `${issuerUrl()}/api/mcp`;
}

export function protectedResourceMetadataUrl() {
  return `${issuerUrl()}/.well-known/oauth-protected-resource/api/mcp`;
}

/** `WWW-Authenticate` value for a 401 from /api/mcp (RFC 9728 §5.1). */
export function mcpChallenge({ invalidToken = false } = {}) {
  const parts = [`resource_metadata="${protectedResourceMetadataUrl()}"`];
  if (invalidToken) parts.push('error="invalid_token"');
  return `Bearer ${parts.join(', ')}`;
}

export function frontendUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:8080').replace(/\/+$/, '');
}

/** Hostnames allowed in redirect URIs (OAUTH_ALLOWED_REDIRECT_HOSTS, comma-separated). */
export function allowedRedirectHosts() {
  const raw = process.env.OAUTH_ALLOWED_REDIRECT_HOSTS;
  const list = raw ? raw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean) : DEFAULT_REDIRECT_HOSTS;
  return new Set(list);
}

/**
 * Redirect-URI policy for client registration: https to an allowlisted host,
 * or http to a loopback host (native clients); no fragment, no credentials.
 *
 * @returns {string|null} an error message, or null when acceptable.
 */
export function redirectUriError(uri) {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > 2000) return 'redirect_uri must be a URL';
  let url;
  try {
    url = new URL(uri);
  } catch {
    return 'redirect_uri must be an absolute URL';
  }
  if (url.hash) return 'redirect_uri must not contain a fragment';
  if (url.username || url.password) return 'redirect_uri must not contain credentials';
  const host = url.hostname.toLowerCase();
  const isLoopback = LOOPBACK_HOSTS.has(host);
  if (url.protocol === 'http:') {
    if (!isLoopback) return 'http redirect URIs are only allowed for localhost';
  } else if (url.protocol !== 'https:') {
    return 'redirect_uri must use https';
  }
  const allowed = allowedRedirectHosts();
  // Loopback clients (Claude Code / Desktop) are allowed as a group.
  const permitted = isLoopback ? allowed.has('localhost') || allowed.has('127.0.0.1') : allowed.has(host);
  if (!permitted) return `redirect host ${host} is not allowed on this Bliss server`;
  return null;
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) === challenge. */
export function verifyPkce(verifier, challenge) {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return false;
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The most an authorization request may be granted. An explicit `mcp:read`
 * caps it at READ_ONLY; `mcp:write`, or no scope at all, allows READ_WRITE.
 * The consent screen defaults to READ_ONLY either way.
 */
export function requestedAccessFromScope(scope) {
  const scopes = new Set(String(scope || '').split(/\s+/).filter(Boolean));
  if (scopes.size === 0 || scopes.has(SCOPE_WRITE)) return 'READ_WRITE';
  return 'READ_ONLY';
}

export function scopeForAccess(accessLevel) {
  return accessLevel === 'READ_WRITE' ? `${SCOPE_READ} ${SCOPE_WRITE}` : SCOPE_READ;
}

/** RFC 8707: a resource indicator, when present, must name the MCP endpoint. */
export function resourceIsValid(resource) {
  if (resource == null || resource === '') return true;
  const normalise = (u) => u.replace(/\/+$/, '');
  return normalise(String(resource)) === normalise(mcpResourceUrl());
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function newRequestId() {
  return crypto.randomBytes(32).toString('base64url');
}

export function newAuthorizationCode() {
  return crypto.randomBytes(32).toString('base64url');
}

export function newRefreshToken() {
  return `${REFRESH_TOKEN_PREFIX}${randomBase62(48)}`;
}

/** Append query parameters to a redirect URI, keeping its own query. */
export function withParams(uri, params) {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/** One structured log line per OAuth step. IDs only — never codes or tokens. */
export function logOAuthEvent(step, fields = {}) {
  console.info(JSON.stringify({ event: 'oauth_event', step, ...fields }));
}
