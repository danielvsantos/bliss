import prisma from '../prisma/prisma.js';
import { generateApiKey, hashApiKey, parseApiKey } from '../utils/apiKeys.js';
import { timingSafeCompare } from '../utils/timingSafeCompare.js';
import {
  ACCESS_TOKEN_TTL_S,
  CODE_TTL_MS,
  CONNECTION_EXPIRY_DAYS,
  REFRESH_TOKEN_PREFIX,
  REFRESH_TOKEN_TTL_MS,
  REQUEST_TTL_MS,
  defaultClientName,
  logOAuthEvent,
  newAuthorizationCode,
  newRefreshToken,
  newRequestId,
  redirectUriError,
  requestedAccessFromScope,
  resourceIsValid,
  scopeForAccess,
  sha256Hex,
  verifyPkce,
  withParams,
  issuerUrl,
} from '../utils/oauth.js';

/**
 * OAuth 2.1 authorization server for the MCP endpoint (#89).
 *
 * An OAuth access token IS an integration key (#84): consent creates an
 * Integration (READ_ONLY or READ_WRITE, never more than requested) whose one
 * ApiKey row is handed out as the access token and re-keyed in place on every
 * refresh. withAuth, the role cap and the denylist therefore apply unchanged,
 * and the connection is visible and revocable in Settings → Integrations.
 */

export const ACCESS_KEY_NAME = 'OAuth access token';
const CLIENT_NAME_MAX = 60;

/** Token-endpoint error (RFC 6749 §5.2). */
export class OAuthError extends Error {
  constructor(error, description, status = 400) {
    super(description || error);
    this.error = error;
    this.description = description;
    this.status = status;
  }
}

/**
 * /authorize error. `redirect: false` errors are shown to the user and never
 * redirected (unknown client or redirect URI — RFC 6749 §4.1.2.1).
 */
export class AuthorizeError extends Error {
  constructor(error, description, { redirect = true } = {}) {
    super(description || error);
    this.error = error;
    this.description = description;
    this.redirect = redirect;
  }
}

// ─── Registration (RFC 7591) ────────────────────────────────────────────────

// A client asking to be confidential (Gemini sends client_secret_basic) is
// registered as a public client instead: RFC 7591 §3.2.1 lets the server
// replace requested metadata, and the response tells it to send no secret.
const ACCEPTED_AUTH_METHODS = new Set(['none', 'client_secret_basic', 'client_secret_post']);

export async function registerClient(body = {}) {
  try {
    return await createClient(body);
  } catch (err) {
    if (err instanceof OAuthError) logOAuthEvent('register_rejected', { error: err.error, reason: err.description });
    throw err;
  }
}

async function createClient(body) {
  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be a non-empty array (max 10)');
  }
  for (const uri of redirectUris) {
    const problem = redirectUriError(uri);
    if (problem) throw new OAuthError('invalid_redirect_uri', problem);
  }
  const grantTypes = body.grant_types ?? ['authorization_code', 'refresh_token'];
  if (!Array.isArray(grantTypes) || grantTypes.some((g) => !['authorization_code', 'refresh_token'].includes(g))) {
    throw new OAuthError('invalid_client_metadata', 'Only authorization_code and refresh_token grants are supported');
  }
  const responseTypes = body.response_types ?? ['code'];
  if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== 'code')) {
    throw new OAuthError('invalid_client_metadata', 'Only the code response type is supported');
  }
  const authMethod = body.token_endpoint_auth_method ?? 'none';
  if (!ACCEPTED_AUTH_METHODS.has(authMethod)) {
    throw new OAuthError('invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none") are supported');
  }
  const rawName = typeof body.client_name === 'string' ? body.client_name.trim() : '';
  const name = (rawName || defaultClientName(redirectUris)).slice(0, CLIENT_NAME_MAX);

  const client = await prisma.oAuthClient.create({ data: { name, redirectUris } });
  logOAuthEvent('register', { clientId: client.id });
  return {
    client_id: client.id,
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    client_name: client.name,
    redirect_uris: client.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

// ─── Authorization request ──────────────────────────────────────────────────

/**
 * Validate an /authorize query and store it as a pending request.
 * @returns {Promise<string>} the request id for the consent page.
 */
export async function createAuthorizationRequest(query, now = new Date()) {
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  const clientId = one(query.client_id);
  const redirectUri = one(query.redirect_uri);

  const client = clientId ? await prisma.oAuthClient.findUnique({ where: { id: String(clientId) } }) : null;
  if (!client) throw new AuthorizeError('invalid_client', 'Unknown client_id', { redirect: false });
  if (!redirectUri || !client.redirectUris.includes(String(redirectUri))) {
    throw new AuthorizeError('invalid_request', 'redirect_uri does not match a registered URI', { redirect: false });
  }

  if (one(query.response_type) !== 'code') {
    throw new AuthorizeError('unsupported_response_type', 'response_type must be "code"');
  }
  const challenge = one(query.code_challenge);
  if (one(query.code_challenge_method) !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(String(challenge || ''))) {
    throw new AuthorizeError('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  }
  const resource = one(query.resource);
  if (!resourceIsValid(resource)) throw new AuthorizeError('invalid_target', 'resource must be this server\'s /api/mcp');

  // Opportunistic housekeeping: expired requests older than a day.
  prisma.oAuthAuthorizationRequest
    .deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 24 * 3600 * 1000) } } })
    .catch(() => {});

  const id = newRequestId();
  await prisma.oAuthAuthorizationRequest.create({
    data: {
      id,
      clientId: client.id,
      redirectUri: String(redirectUri),
      state: one(query.state) ? String(one(query.state)).slice(0, 500) : null,
      codeChallenge: String(challenge),
      requestedAccess: requestedAccessFromScope(one(query.scope)),
      resource: resource ? String(resource) : null,
      expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
    },
  });
  prisma.oAuthClient.update({ where: { id: client.id }, data: { lastUsedAt: now } }).catch(() => {});
  logOAuthEvent('authorize', { clientId: client.id });
  return id;
}

/** Load a pending request for the consent page and bind it to this user. */
export async function loadRequestForUser(id, user, now = new Date()) {
  const request = await prisma.oAuthAuthorizationRequest.findUnique({
    where: { id: String(id) },
    include: { client: { select: { id: true, name: true } } },
  });
  if (!request) return { status: 404, error: 'This connection request was not found. Start again from your app.' };
  if (request.usedAt || request.codeHash) return { status: 410, error: 'This connection request was already used.' };
  if (request.expiresAt <= now) return { status: 410, error: 'This connection request has expired. Start again from your app.' };
  if (request.userId && request.userId !== user.id) {
    return { status: 403, error: 'This connection request belongs to another user.' };
  }
  if (!request.userId) {
    const bound = await prisma.oAuthAuthorizationRequest.updateMany({
      where: { id: request.id, userId: null },
      data: { userId: user.id, tenantId: user.tenantId },
    });
    if (bound.count === 0) return { status: 403, error: 'This connection request belongs to another user.' };
  }
  return { request };
}

export function serializeConsent(request, user) {
  return {
    request: {
      id: request.id,
      clientName: request.client.name,
      redirectHost: new URL(request.redirectUri).host,
      maxAccessLevel: request.requestedAccess,
      expiresAt: request.expiresAt,
    },
    canApprove: user.role === 'admin',
    expiryOptions: CONNECTION_EXPIRY_DAYS,
  };
}

/** Admin approved: create the Integration and a one-time authorization code. */
export async function approveRequest(request, user, { accessLevel, expiresInDays }, now = new Date()) {
  if (!['READ_ONLY', 'READ_WRITE'].includes(accessLevel)) {
    throw new OAuthError('invalid_request', 'accessLevel must be READ_ONLY or READ_WRITE');
  }
  if (request.requestedAccess === 'READ_ONLY' && accessLevel === 'READ_WRITE') {
    throw new OAuthError('invalid_request', 'The app only asked for read-only access');
  }
  if (!CONNECTION_EXPIRY_DAYS.includes(expiresInDays)) {
    throw new OAuthError('invalid_request', 'expiresInDays must be 30, 90, 365 or null');
  }

  const code = newAuthorizationCode();
  const connectionExpiresAt = expiresInDays == null ? null : new Date(now.getTime() + expiresInDays * 86_400_000);
  const clientName = request.client?.name
    ?? (await prisma.oAuthClient.findUnique({ where: { id: request.clientId } }))?.name
    ?? 'MCP client';

  const integration = await prisma.$transaction(async (tx) => {
    // Claim the request first so a double-submit cannot mint two codes.
    const claimed = await tx.oAuthAuthorizationRequest.updateMany({
      where: { id: request.id, userId: user.id, codeHash: null, usedAt: null, expiresAt: { gt: now } },
      data: { codeHash: sha256Hex(code), codeExpiresAt: new Date(now.getTime() + CODE_TTL_MS) },
    });
    if (claimed.count === 0) throw new OAuthError('invalid_request', 'This connection request is no longer valid');
    const created = await tx.integration.create({
      data: {
        tenantId: user.tenantId,
        name: clientName.slice(0, 80),
        // The Integrations tab shows an OAuth badge; no description needed.
        description: null,
        accessLevel,
        createdByUserId: user.id,
        oauthClientId: request.clientId,
        connectionExpiresAt,
      },
    });
    await tx.oAuthAuthorizationRequest.update({
      where: { id: request.id },
      data: { integrationId: created.id, tenantId: user.tenantId },
    });
    return created;
  });

  logOAuthEvent('consent_approved', { clientId: request.clientId, tenantId: user.tenantId, integrationId: integration.id, accessLevel });
  return {
    redirectUrl: withParams(request.redirectUri, { code, state: request.state, iss: issuerUrl() }),
    integrationId: integration.id,
  };
}

export async function denyRequest(request, user, now = new Date()) {
  await prisma.oAuthAuthorizationRequest.updateMany({
    where: { id: request.id, userId: user.id, usedAt: null },
    data: { usedAt: now },
  });
  logOAuthEvent('consent_denied', { clientId: request.clientId, tenantId: user.tenantId });
  return {
    redirectUrl: withParams(request.redirectUri, {
      error: 'access_denied', error_description: 'The user denied access', state: request.state, iss: issuerUrl(),
    }),
  };
}

// ─── Tokens ─────────────────────────────────────────────────────────────────

/** Revoke an OAuth connection: integration, its keys and refresh tokens. */
export async function revokeConnection(integrationId, reason, now = new Date()) {
  await prisma.$transaction([
    prisma.integration.updateMany({ where: { id: integrationId, revokedAt: null }, data: { revokedAt: now } }),
    prisma.apiKey.updateMany({ where: { integrationId, revokedAt: null }, data: { revokedAt: now } }),
    prisma.oAuthRefreshToken.updateMany({ where: { integrationId, revokedAt: null }, data: { revokedAt: now } }),
  ]);
  logOAuthEvent('revoked', { integrationId, reason });
}

function minDate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/**
 * Issue a fresh access token (re-keying the connection's single ApiKey row)
 * and a new refresh token.
 */
async function issueTokens(integration, now) {
  const accessExpiresAt = minDate(new Date(now.getTime() + ACCESS_TOKEN_TTL_S * 1000), integration.connectionExpiresAt);
  const refreshExpiresAt = minDate(new Date(now.getTime() + REFRESH_TOKEN_TTL_MS), integration.connectionExpiresAt);
  const { token, prefix, keyHash } = generateApiKey();
  const refreshToken = newRefreshToken();

  await prisma.$transaction(async (tx) => {
    const existing = await tx.apiKey.findFirst({
      where: { integrationId: integration.id, name: ACCESS_KEY_NAME },
      select: { id: true },
    });
    if (existing) {
      await tx.apiKey.update({
        where: { id: existing.id },
        data: { prefix, keyHash, expiresAt: accessExpiresAt, revokedAt: null },
      });
    } else {
      await tx.apiKey.create({
        data: {
          tenantId: integration.tenantId, integrationId: integration.id, name: ACCESS_KEY_NAME,
          prefix, keyHash, expiresAt: accessExpiresAt,
        },
      });
    }
    await tx.oAuthRefreshToken.create({
      data: {
        tenantId: integration.tenantId, integrationId: integration.id,
        tokenHash: sha256Hex(refreshToken), expiresAt: refreshExpiresAt,
      },
    });
  });

  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: Math.max(1, Math.round((accessExpiresAt.getTime() - now.getTime()) / 1000)),
    refresh_token: refreshToken,
    scope: scopeForAccess(integration.accessLevel),
  };
}

function assertUsable(integration, clientId, now) {
  if (!integration || integration.oauthClientId !== clientId) throw new OAuthError('invalid_grant', 'Grant does not belong to this client');
  if (integration.revokedAt) throw new OAuthError('invalid_grant', 'The connection was revoked in Bliss');
  if (integration.connectionExpiresAt && integration.connectionExpiresAt <= now) {
    throw new OAuthError('invalid_grant', 'The connection has expired; connect again');
  }
}

/** grant_type=authorization_code */
export async function exchangeAuthorizationCode(params, now = new Date()) {
  const { code, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId, resource } = params;
  if (!code || !verifier || !redirectUri || !clientId) {
    throw new OAuthError('invalid_request', 'code, code_verifier, redirect_uri and client_id are required');
  }
  const request = await prisma.oAuthAuthorizationRequest.findUnique({ where: { codeHash: sha256Hex(code) } });
  if (!request) throw new OAuthError('invalid_grant', 'Unknown authorization code');

  if (request.usedAt) {
    // Code replay: revoke everything issued from it (OAuth 2.1 §4.1.3).
    if (request.integrationId) await revokeConnection(request.integrationId, 'code_reuse', now);
    throw new OAuthError('invalid_grant', 'Authorization code already used');
  }
  if (!request.codeExpiresAt || request.codeExpiresAt <= now) throw new OAuthError('invalid_grant', 'Authorization code expired');
  if (request.clientId !== clientId) throw new OAuthError('invalid_grant', 'Authorization code was issued to another client');
  if (request.redirectUri !== redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri does not match');
  if (!verifyPkce(verifier, request.codeChallenge)) throw new OAuthError('invalid_grant', 'PKCE verification failed');
  if (!resourceIsValid(resource) || (request.resource && resource && request.resource !== resource)) {
    throw new OAuthError('invalid_target', 'resource does not match');
  }

  const claimed = await prisma.oAuthAuthorizationRequest.updateMany({
    where: { id: request.id, usedAt: null },
    data: { usedAt: now },
  });
  if (claimed.count === 0) throw new OAuthError('invalid_grant', 'Authorization code already used');

  const integration = request.integrationId
    ? await prisma.integration.findUnique({ where: { id: request.integrationId } })
    : null;
  assertUsable(integration, clientId, now);
  const tokens = await issueTokens(integration, now);
  logOAuthEvent('token_issued', { clientId, tenantId: integration.tenantId, integrationId: integration.id });
  return tokens;
}

/** grant_type=refresh_token (rotating, with reuse detection) */
export async function refreshAccessToken(params, now = new Date()) {
  const { refresh_token: refreshToken, client_id: clientId } = params;
  if (!refreshToken || !clientId) throw new OAuthError('invalid_request', 'refresh_token and client_id are required');
  if (!String(refreshToken).startsWith(REFRESH_TOKEN_PREFIX)) throw new OAuthError('invalid_grant', 'Unknown refresh token');

  const stored = await prisma.oAuthRefreshToken.findUnique({
    where: { tokenHash: sha256Hex(refreshToken) },
    include: { integration: true },
  });
  if (!stored) throw new OAuthError('invalid_grant', 'Unknown refresh token');
  if (stored.integration?.oauthClientId !== clientId) throw new OAuthError('invalid_grant', 'Refresh token was issued to another client');

  if (stored.usedAt) {
    await revokeConnection(stored.integrationId, 'refresh_token_reuse', now);
    logOAuthEvent('refresh_reuse_detected', { clientId, integrationId: stored.integrationId });
    throw new OAuthError('invalid_grant', 'Refresh token already used; the connection was revoked');
  }
  if (stored.revokedAt) throw new OAuthError('invalid_grant', 'Refresh token revoked');
  if (stored.expiresAt <= now) throw new OAuthError('invalid_grant', 'Refresh token expired');
  assertUsable(stored.integration, clientId, now);

  const claimed = await prisma.oAuthRefreshToken.updateMany({
    where: { id: stored.id, usedAt: null, revokedAt: null },
    data: { usedAt: now },
  });
  if (claimed.count === 0) throw new OAuthError('invalid_grant', 'Refresh token already used');

  // Housekeeping: drop this connection's spent tokens older than 30 days.
  prisma.oAuthRefreshToken
    .deleteMany({ where: { integrationId: stored.integrationId, usedAt: { lt: new Date(now.getTime() - REFRESH_TOKEN_TTL_MS) } } })
    .catch(() => {});

  const tokens = await issueTokens(stored.integration, now);
  logOAuthEvent('token_refreshed', { clientId, tenantId: stored.tenantId, integrationId: stored.integrationId });
  return tokens;
}

/** RFC 7009: revoke by refresh token or access token; unknown tokens are a no-op. */
export async function revokeToken({ token, client_id: clientId }, now = new Date()) {
  if (!token || !clientId) throw new OAuthError('invalid_request', 'token and client_id are required');
  let integrationId = null;
  if (String(token).startsWith(REFRESH_TOKEN_PREFIX)) {
    const stored = await prisma.oAuthRefreshToken.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { integration: { select: { oauthClientId: true } } },
    });
    if (stored?.integration?.oauthClientId === clientId) integrationId = stored.integrationId;
  } else if (parseApiKey(token)) {
    const { prefix } = parseApiKey(token);
    const key = await prisma.apiKey.findUnique({ where: { prefix }, include: { integration: { select: { oauthClientId: true } } } });
    if (key && timingSafeCompare(hashApiKey(token), key.keyHash) && key.integration?.oauthClientId === clientId) {
      integrationId = key.integrationId;
    }
  }
  if (integrationId) await revokeConnection(integrationId, 'client_revocation', now);
}
