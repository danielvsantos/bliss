/**
 * Integration tests — OAuth 2.1 for the MCP server (#89).
 *
 * Runs the whole flow a Claude connector performs against the real handlers
 * (helpers/mcpServer.ts serves every Pages Router route, with the next.config
 * discovery rewrites): 401 challenge → discovery → dynamic registration →
 * authorize → consent (admin) → token → MCP tools → refresh rotation → reuse
 * detection → revocation. Plus the failure paths: PKCE, redirect, code reuse
 * and expiry, non-admin consent, request binding, denylist, allowlist.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'crypto';

vi.mock('../../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
  createRateLimiter: vi.fn().mockReturnValue((_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock('../../../../utils/produceEvent.js', () => ({ produceEvent: vi.fn().mockResolvedValue(undefined) }));

import prisma from '../../../../prisma/prisma.js';
import { createIsolatedTenant, teardownTenant, type IsolatedTenant } from '../../../helpers/tenant.js';
import { createIntegrationKey, createTenantUser } from '../../../helpers/integration.js';
import { startLoopbackServer, makeFetchStub, connectMcp, type LoopbackServer } from '../../../helpers/mcpServer.js';

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const GEMINI_CALLBACK = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-abc123-bliss.test';

let server: LoopbackServer;
const realFetch = globalThis.fetch;
const { stub } = makeFetchStub(realFetch, () => server.baseUrl);
let tenant: IsolatedTenant;
let member: { userId: string; token: string };

function pkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const api = (path: string, init: RequestInit = {}) => realFetch(`${server.baseUrl}${path}`, { redirect: 'manual', ...init });
const asUser = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });
const form = (body: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});

async function register(redirectUris = [CALLBACK]) {
  const res = await api('/api/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: redirectUris }),
  });
  return { res, body: await res.json() };
}

/** authorize → consent → approve; returns the code, verifier and client. */
async function authorizeAndApprove({
  clientId, accessLevel = 'READ_ONLY', scope = 'mcp:read mcp:write', jwt = tenant.token, redirectUri = CALLBACK,
}: { clientId: string; accessLevel?: string; scope?: string; jwt?: string; redirectUri?: string }) {
  const { verifier, challenge } = pkce();
  const qs = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'xyz', scope, resource: `${server.baseUrl}/api/mcp`,
  });
  const auth = await api(`/api/oauth/authorize?${qs}`);
  expect(auth.status).toBe(302);
  const consentUrl = new URL(auth.headers.get('location')!);
  expect(consentUrl.pathname).toBe('/oauth/consent');
  const requestId = consentUrl.searchParams.get('request')!;

  const consent = await api(`/api/oauth/requests/${requestId}`, { headers: asUser(jwt) });
  const consentBody = await consent.json();
  const approve = await api(`/api/oauth/requests/${requestId}/approve`, {
    method: 'POST', headers: asUser(jwt), body: JSON.stringify({ accessLevel, expiresInDays: 90 }),
  });
  const approveBody = await approve.json();
  const redirect = approveBody.redirectUrl ? new URL(approveBody.redirectUrl) : null;
  return { requestId, consent, consentBody, approve, approveBody, code: redirect?.searchParams.get('code') ?? null, redirect, verifier };
}

async function exchange(clientId: string, code: string, verifier: string, extra: Record<string, string> = {}) {
  const res = await api('/api/oauth/token', form({
    grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CALLBACK, client_id: clientId,
    resource: `${server.baseUrl}/api/mcp`, ...extra,
  }));
  return { res, body: await res.json() };
}

async function refresh(clientId: string, refreshToken: string) {
  const res = await api('/api/oauth/token', form({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }));
  return { res, body: await res.json() };
}

async function mcpInit(accessToken: string) {
  return api('/api/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
  });
}

beforeAll(async () => {
  vi.stubGlobal('fetch', stub);
  server = await startLoopbackServer();
  process.env.OAUTH_ISSUER_URL = server.baseUrl;
  process.env.FRONTEND_URL = 'http://localhost:8080';
  tenant = await createIsolatedTenant('oauth');
  member = await createTenantUser(tenant.tenantId, 'member');
});

afterAll(async () => {
  await prisma.oAuthClient.deleteMany({ where: { integrations: { some: { tenantId: tenant.tenantId } } } });
  await teardownTenant(tenant.tenantId);
  await server.close();
  delete process.env.OAUTH_ISSUER_URL;
  vi.unstubAllGlobals();
});

describe('discovery', () => {
  it('/api/mcp without a token answers 401 with a resource_metadata challenge that resolves', async () => {
    const res = await mcpInit('');
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate')!;
    expect(challenge).toMatch(/^Bearer resource_metadata="/);
    const prmUrl = challenge.match(/resource_metadata="([^"]+)"/)![1];
    expect(prmUrl).toBe(`${server.baseUrl}/.well-known/oauth-protected-resource/api/mcp`);

    const prm = await (await realFetch(prmUrl)).json();
    expect(prm).toMatchObject({ resource: `${server.baseUrl}/api/mcp`, authorization_servers: [server.baseUrl], scopes_supported: ['mcp:read', 'mcp:write'] });

    for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/api/mcp']) {
      const res2 = await realFetch(`${server.baseUrl}${path}`);
      expect(res2.headers.get('access-control-allow-origin')).toBe('*');
      expect(await res2.json()).toMatchObject({
        issuer: server.baseUrl,
        authorization_endpoint: `${server.baseUrl}/api/oauth/authorize`,
        token_endpoint: `${server.baseUrl}/api/oauth/token`,
        registration_endpoint: `${server.baseUrl}/api/oauth/register`,
        revocation_endpoint: `${server.baseUrl}/api/oauth/revoke`,
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
  });

  it('an invalid bliss_ token gets error="invalid_token" so the client refreshes', async () => {
    const res = await mcpInit('bliss_AAAAAAAA_notarealsecretnotarealsecretnotarealse');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });
});

describe('dynamic client registration', () => {
  it('registers a public client with an allowlisted redirect', async () => {
    const { res, body } = await register();
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' });
    expect(body.client_id).toEqual(expect.any(String));
  });

  it('rejects hosts outside the allowlist, http on public hosts, fragments and confidential clients', async () => {
    for (const uri of ['https://evil.example/cb', 'http://claude.ai/cb', 'https://claude.ai/cb#x', 'javascript:alert(1)']) {
      const { res, body } = await register([uri]);
      expect(res.status, uri).toBe(400);
      expect(body.error).toBe('invalid_redirect_uri');
    }
    const res = await api('/api/oauth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'private_key_jwt' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_client_metadata');
  });

  it('registers a client asking for client_secret_basic as a public client, without a secret', async () => {
    for (const method of ['client_secret_basic', 'client_secret_post']) {
      const res = await api('/api/oauth/register', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: method }),
      });
      expect(res.status, method).toBe(201);
      const body = await res.json();
      expect(body.token_endpoint_auth_method).toBe('none');
      expect(body).not.toHaveProperty('client_secret');
    }
  });

  it('Gemini: registers as Gemini, client_id by HTTP Basic at the token endpoint, tools work', async () => {
    const reg = await api('/api/oauth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [GEMINI_CALLBACK], token_endpoint_auth_method: 'client_secret_basic',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'mcp:read offline_access',
      }),
    });
    expect(reg.status).toBe(201);
    const client = await reg.json();
    expect(client).toMatchObject({ client_name: 'Gemini', redirect_uris: [GEMINI_CALLBACK], token_endpoint_auth_method: 'none' });

    const flow = await authorizeAndApprove({ clientId: client.client_id, redirectUri: GEMINI_CALLBACK });
    expect(flow.consentBody.request).toMatchObject({ clientName: 'Gemini', redirectHost: 'oauth-redirect.googleusercontent.com' });
    expect(flow.redirect!.origin + flow.redirect!.pathname).toBe(GEMINI_CALLBACK);
    const integration = await prisma.integration.findFirst({ where: { oauthClientId: client.client_id } });
    expect(integration).toMatchObject({ name: 'Gemini', oauthClientId: client.client_id, tenantId: tenant.tenantId });

    const basic = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:`).toString('base64')}`;
    const res = await api('/api/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: flow.code!, code_verifier: flow.verifier, redirect_uri: GEMINI_CALLBACK,
      }).toString(),
    });
    const tokens = await res.json();
    expect(res.status).toBe(200);
    expect((await mcpInit(tokens.access_token)).status).toBe(200);
  });

  it('allows loopback redirects for native clients', async () => {
    const { res } = await register(['http://localhost:33418/callback', 'http://127.0.0.1:5000/cb']);
    expect(res.status).toBe(201);
  });
});

describe('full flow', () => {
  it('read-only consent → 22 tools; refresh rotates; reuse revokes the connection', async () => {
    const { body: client } = await register();
    const flow = await authorizeAndApprove({ clientId: client.client_id, accessLevel: 'READ_ONLY' });
    expect(flow.consent.status).toBe(200);
    expect(flow.consentBody).toMatchObject({
      request: { clientName: 'Claude', redirectHost: 'claude.ai', maxAccessLevel: 'READ_WRITE' },
      canApprove: true,
    });
    expect(flow.approve.status).toBe(200);
    expect(flow.redirect!.origin + flow.redirect!.pathname).toBe(CALLBACK);
    expect(flow.redirect!.searchParams.get('state')).toBe('xyz');
    expect(flow.redirect!.searchParams.get('iss')).toBe(server.baseUrl);

    const { res, body: tokens } = await exchange(client.client_id, flow.code!, flow.verifier);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp:read' });
    expect(tokens.access_token).toMatch(/^bliss_[A-Za-z0-9]{8}_/);
    expect(tokens.refresh_token).toMatch(/^bliss_rt_/);

    const mcp = await connectMcp(server.baseUrl, tokens.access_token);
    expect((await mcp.listTools()).tools).toHaveLength(22);
    await mcp.close();

    // The connection shows up in Settings → Integrations.
    const list = await (await api('/api/integrations', { headers: asUser(tenant.token) })).json();
    const integration = list.integrations.find((i: any) => i.oauth?.clientName === 'Claude' && i.accessLevel === 'READ_ONLY' && i.status === 'active');
    expect(integration).toBeDefined();
    expect(integration.oauth.connectionExpiresAt).toEqual(expect.any(String));
    const addKey = await api(`/api/integrations/${integration.id}/keys`, {
      method: 'POST', headers: asUser(tenant.token), body: JSON.stringify({ name: 'x', expiresInDays: 30 }),
    });
    expect(addKey.status).toBe(409);

    // Refresh: new pair, the old access token stops working at once.
    const r1 = await refresh(client.client_id, tokens.refresh_token);
    expect(r1.res.status).toBe(200);
    expect(r1.body.access_token).not.toBe(tokens.access_token);
    expect(r1.body.refresh_token).not.toBe(tokens.refresh_token);
    const old = await mcpInit(tokens.access_token);
    expect(old.status).toBe(401);
    expect(old.headers.get('www-authenticate')).toContain('invalid_token');
    expect((await mcpInit(r1.body.access_token)).status).toBe(200);
    expect(await prisma.apiKey.count({ where: { integrationId: integration.id } })).toBe(1);

    // Reusing the first refresh token revokes the whole connection.
    const reuse = await refresh(client.client_id, tokens.refresh_token);
    expect(reuse.res.status).toBe(400);
    expect(reuse.body.error).toBe('invalid_grant');
    expect((await mcpInit(r1.body.access_token)).status).toBe(401);
    expect((await refresh(client.client_id, r1.body.refresh_token)).body.error).toBe('invalid_grant');
    expect((await prisma.integration.findUnique({ where: { id: integration.id } }))!.revokedAt).not.toBeNull();
  });

  it('read & write consent → 41 tools; revoking in Settings stops refresh', async () => {
    const { body: client } = await register();
    const flow = await authorizeAndApprove({ clientId: client.client_id, accessLevel: 'READ_WRITE' });
    const { body: tokens } = await exchange(client.client_id, flow.code!, flow.verifier);
    expect(tokens.scope).toBe('mcp:read mcp:write');
    const mcp = await connectMcp(server.baseUrl, tokens.access_token);
    expect((await mcp.listTools()).tools).toHaveLength(41);
    await mcp.close();

    const integrationId = (await prisma.oAuthAuthorizationRequest.findUnique({ where: { id: flow.requestId } }))!.integrationId!;
    const del = await api(`/api/integrations/${integrationId}`, { method: 'DELETE', headers: asUser(tenant.token) });
    expect(del.status).toBe(200);
    const r = await refresh(client.client_id, tokens.refresh_token);
    expect(r.body).toMatchObject({ error: 'invalid_grant' });
    expect((await mcpInit(tokens.access_token)).status).toBe(401);
  });

  it('consent can only downgrade: scope mcp:read cannot be approved as READ_WRITE', async () => {
    const { body: client } = await register();
    const flow = await authorizeAndApprove({ clientId: client.client_id, scope: 'mcp:read', accessLevel: 'READ_WRITE' });
    expect(flow.consentBody.request.maxAccessLevel).toBe('READ_ONLY');
    expect(flow.approve.status).toBe(400);
  });

  it('RFC 7009 revocation by refresh token ends the connection; unknown tokens are a no-op', async () => {
    const { body: client } = await register();
    const flow = await authorizeAndApprove({ clientId: client.client_id });
    const { body: tokens } = await exchange(client.client_id, flow.code!, flow.verifier);
    const res = await api('/api/oauth/revoke', form({ token: tokens.refresh_token, client_id: client.client_id }));
    expect(res.status).toBe(200);
    expect((await mcpInit(tokens.access_token)).status).toBe(401);
    const unknown = await api('/api/oauth/revoke', form({ token: 'bliss_rt_nope', client_id: client.client_id }));
    expect(unknown.status).toBe(200);
  });

  it('revocation by access token also works, but only for the issuing client', async () => {
    const { body: client } = await register();
    const { body: other } = await register();
    const flow = await authorizeAndApprove({ clientId: client.client_id });
    const { body: tokens } = await exchange(client.client_id, flow.code!, flow.verifier);
    await api('/api/oauth/revoke', form({ token: tokens.access_token, client_id: other.client_id }));
    expect((await mcpInit(tokens.access_token)).status).toBe(200);
    await api('/api/oauth/revoke', form({ token: tokens.access_token, client_id: client.client_id }));
    expect((await mcpInit(tokens.access_token)).status).toBe(401);
  });
});

describe('failure paths', () => {
  it('wrong PKCE verifier, redirect or client → invalid_grant; the code stays single-use', async () => {
    const { body: client } = await register([CALLBACK, 'https://claude.com/api/mcp/auth_callback']);
    const { body: other } = await register();
    const flow = await authorizeAndApprove({ clientId: client.client_id });
    expect((await exchange(client.client_id, flow.code!, pkce().verifier)).body.error).toBe('invalid_grant');
    expect((await exchange(other.client_id, flow.code!, flow.verifier)).body.error).toBe('invalid_grant');
    expect((await exchange(client.client_id, flow.code!, flow.verifier, { redirect_uri: 'https://claude.com/api/mcp/auth_callback' })).body.error).toBe('invalid_grant');
    expect((await exchange(client.client_id, flow.code!, flow.verifier, { resource: 'https://evil.example/api/mcp' })).body.error).toBe('invalid_target');
    // Checks above don't burn the code…
    const ok = await exchange(client.client_id, flow.code!, flow.verifier);
    expect(ok.res.status).toBe(200);
    // …but redeeming it twice revokes what it issued.
    expect((await exchange(client.client_id, flow.code!, flow.verifier)).body.error).toBe('invalid_grant');
    expect((await mcpInit(ok.body.access_token)).status).toBe(401);
  });

  it('an expired code is refused', async () => {
    const { body: client } = await register();
    const flow = await authorizeAndApprove({ clientId: client.client_id });
    await prisma.oAuthAuthorizationRequest.update({ where: { id: flow.requestId }, data: { codeExpiresAt: new Date(Date.now() - 1000) } });
    expect((await exchange(client.client_id, flow.code!, flow.verifier)).body.error).toBe('invalid_grant');
  });

  it('unsupported grant type and missing parameters', async () => {
    expect((await (await api('/api/oauth/token', form({ grant_type: 'password' }))).json()).error).toBe('unsupported_grant_type');
    expect((await (await api('/api/oauth/token', form({ grant_type: 'authorization_code' }))).json()).error).toBe('invalid_request');
  });

  it('authorize: unknown client or redirect → error page; bad PKCE → redirect with error', async () => {
    const { body: client } = await register();
    const base = { response_type: 'code', code_challenge_method: 'S256', code_challenge: pkce().challenge, state: 's' };
    const unknown = await api(`/api/oauth/authorize?${new URLSearchParams({ ...base, client_id: 'nope', redirect_uri: CALLBACK })}`);
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get('content-type')).toContain('text/html');
    const badRedirect = await api(`/api/oauth/authorize?${new URLSearchParams({ ...base, client_id: client.client_id, redirect_uri: 'https://claude.ai/other' })}`);
    expect(badRedirect.status).toBe(400);
    const plain = await api(`/api/oauth/authorize?${new URLSearchParams({ ...base, client_id: client.client_id, redirect_uri: CALLBACK, code_challenge_method: 'plain' })}`);
    expect(plain.status).toBe(302);
    const loc = new URL(plain.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(CALLBACK);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('state')).toBe('s');
  });

  it('only admins can approve; the request is bound to the first user who opens it', async () => {
    const { body: client } = await register();
    const flow = await authorizeAndApprove({ clientId: client.client_id, jwt: member.token });
    expect(flow.consent.status).toBe(200);
    expect(flow.consentBody.canApprove).toBe(false);
    expect(flow.approve.status).toBe(403);
    // Now bound to the member: the admin cannot hijack it.
    const asAdmin = await api(`/api/oauth/requests/${flow.requestId}`, { headers: asUser(tenant.token) });
    expect(asAdmin.status).toBe(403);
  });

  it('deny redirects with access_denied and burns the request', async () => {
    const { body: client } = await register();
    const { challenge } = pkce();
    const auth = await api(`/api/oauth/authorize?${new URLSearchParams({
      response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: challenge,
      code_challenge_method: 'S256', state: 'q',
    })}`);
    const requestId = new URL(auth.headers.get('location')!).searchParams.get('request')!;
    const deny = await (await api(`/api/oauth/requests/${requestId}/deny`, { method: 'POST', headers: asUser(tenant.token) })).json();
    const url = new URL(deny.redirectUrl);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('q');
    expect((await api(`/api/oauth/requests/${requestId}`, { headers: asUser(tenant.token) })).status).toBe(410);
  });

  it('integration keys cannot reach the consent API (denylist)', async () => {
    const key = await createIntegrationKey(tenant, { accessLevel: 'READ_WRITE' });
    const res = await api('/api/oauth/requests/whatever', { headers: { authorization: `Bearer ${key.token}` } });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_AVAILABLE_TO_INTEGRATIONS');
  });
});
