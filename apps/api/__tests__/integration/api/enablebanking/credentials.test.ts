/**
 * Integration tests for per-tenant Enable Banking credentials (#148), against
 * the real bliss_test database:
 *
 *   access (admin only, integration tokens denied) → PUT (probe outcomes, key
 *   formats from the shared test keys, nothing stored on rejection) → key
 *   rotation → app change (confirmation, LOGIN_REQUIRED / APP_CHANGED) →
 *   remove (confirmation, paused, REMOVED as the "previous app") → re-verify
 *   → history cap → tenant isolation of the signing app → no key leaks.
 *
 * withAuth is real (JWT cookie / integration key). Mocked: rate limiter,
 * produceEvent, Sentry, and global fetch (Enable Banking's HTTP API).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('../../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
  createRateLimiter: vi.fn().mockReturnValue((_req: unknown, _res: unknown, next: () => void) => next()),
}));

const { mockProduceEvent, mockCaptureException } = vi.hoisted(() => ({
  mockProduceEvent: vi.fn().mockResolvedValue(undefined),
  mockCaptureException: vi.fn(),
}));
vi.mock('../../../../utils/produceEvent.js', () => ({ produceEvent: mockProduceEvent }));
vi.mock('@sentry/nextjs', () => ({ captureException: mockCaptureException, captureMessage: vi.fn(), init: vi.fn() }));

import prisma from '../../../../prisma/prisma.js';
import { createIsolatedTenant, teardownTenant } from '../../../helpers/tenant.js';
import { createIntegrationKey, createTenantUser, bearer } from '../../../helpers/integration';
import { readTestKey, TEST_KEY_MANIFEST, saveTestCredential } from '../../../helpers/enableBanking';
import { createFakeRedis } from '../../../helpers/fakeRedis';
import { __setRedisClientForTests } from '../../../../utils/redisClient.js';
import { __setEnableBankingClientForTests } from '../../../../utils/enableBanking.js';

import credentialsHandler from '../../../../pages/api/enablebanking/credentials/index.js';
import verifyHandler from '../../../../pages/api/enablebanking/credentials/verify.js';
import statusHandler from '../../../../pages/api/enablebanking/status.js';
import aspspsHandler from '../../../../pages/api/enablebanking/aspsps.js';
import connectHandler from '../../../../pages/api/enablebanking/connect.js';
import summaryHandler from '../../../../pages/api/notifications/summary.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const APP_A = '11111111-2222-4333-8444-555555555555';
const APP_B = '99999999-8888-4777-8666-555555555555';
const CALLBACK = 'https://api.example.test/api/enablebanking/callback';

function makeReq(opts: { token?: string | null; headers?: Record<string, string> } & Partial<NextApiRequest> = {}): NextApiRequest {
  const { token = null, headers = {}, ...overrides } = opts;
  return {
    method: 'GET',
    headers,
    cookies: token ? { token } : {},
    body: {},
    query: {},
    url: '/api/enablebanking/credentials',
    ...overrides,
  } as unknown as NextApiRequest;
}

function makeRes() {
  const res: any = { _status: undefined, _body: undefined, _headers: {} };
  res.status = vi.fn((c: number) => { res._status = c; return res; });
  res.json = vi.fn((b: unknown) => { res._body = b; return res; });
  res.setHeader = vi.fn((k: string, v: unknown) => { res._headers[k] = v; return res; });
  res.end = vi.fn(() => res);
  res.redirect = vi.fn();
  return res;
}

const responses: any[] = [];
async function call(handler: any, req: NextApiRequest) {
  const res = makeRes();
  await handler(req, res as unknown as NextApiResponse);
  responses.push(res._body);
  return res;
}

/** Enable Banking's HTTP API: one handler per path; records the signing app of each call. */
type Reply = { status: number; body?: unknown } | Error;
let routes: Record<string, () => Reply>;
const signedWith: Array<{ path: string; kid: string }> = [];
const fetchMock = vi.fn(async (url: string, init: any) => {
  const path = new URL(url).pathname;
  const jwtHeader = JSON.parse(Buffer.from(init.headers.Authorization.slice(7).split('.')[0], 'base64url').toString());
  signedWith.push({ path, kid: jwtHeader.kid });
  const reply = (routes[path] || (() => ({ status: 404, body: { error: 'NOT_FOUND' } })))();
  if (reply instanceof Error) throw reply;
  return { ok: reply.status < 400, status: reply.status, text: async () => (reply.body === undefined ? '' : JSON.stringify(reply.body)) };
});
const appOk = (): Reply => ({ status: 200, body: { name: 'Bliss', redirect_urls: [CALLBACK] } });

const PEM_2048 = readTestKey('rsa2048-pkcs8.pem');
const PEM_4096 = readTestKey('rsa4096-pkcs8.pem');

let admin: { tenantId: string; userId: string; token: string };
let memberToken: string;
let viewerToken: string;
const env = { ...process.env };
const consoleLines: string[] = [];
let consoleSpies: Array<{ mockRestore: () => void }> = [];

const put = (body: Record<string, unknown>, token = admin.token) =>
  call(credentialsHandler, makeReq({ token, method: 'PUT', body }));
const get = (token = admin.token) => call(credentialsHandler, makeReq({ token }));
const del = (confirm = false, token = admin.token) =>
  call(credentialsHandler, makeReq({ token, method: 'DELETE', query: confirm ? { confirm: 'true' } : {} }));
const counts = async (tenantId = admin.tenantId) => ({
  credentials: await prisma.enableBankingCredential.count({ where: { tenantId } }),
  events: await prisma.enableBankingCredentialEvent.count({ where: { tenantId } }),
});

async function ebItem(tenantId: string, userId: string, status = 'ACTIVE') {
  return prisma.plaidItem.create({
    data: {
      tenantId, userId, itemId: `eb_${Date.now()}_${Math.random()}`, accessToken: 'sess', provider: 'ENABLE_BANKING',
      institutionName: 'Revolut', aspspCountry: 'ES', status,
    },
  });
}

beforeAll(async () => {
  process.env.NEXTAUTH_SECRET = 'eb-test-secret';
  process.env.NEXTAUTH_URL = 'https://api.example.test';
  delete process.env.ENABLE_BANKING_REDIRECT_URL;
  admin = await createIsolatedTenant('eb-credentials');
  memberToken = (await createTenantUser(admin.tenantId, 'member')).token;
  viewerToken = (await createTenantUser(admin.tenantId, 'viewer')).token;
});

beforeEach(() => {
  routes = { '/application': appOk };
  signedWith.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  __setEnableBankingClientForTests(null as any);
  consoleSpies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { consoleLines.push(args.map(String).join(' ')); }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const spy of consoleSpies) spy.mockRestore();
});

afterAll(async () => {
  __setRedisClientForTests(null as any);
  process.env = { ...env };
  await teardownTenant(admin.tenantId);
});

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

describe('access', () => {
  it.each([['member'], ['viewer']])('%s → 403 on every credential route, nothing written', async (role) => {
    const token = role === 'member' ? memberToken : viewerToken;
    const before = await counts();
    for (const res of [
      await get(token),
      await put({ appId: APP_A, privateKey: PEM_2048 }, token),
      await del(true, token),
      await call(verifyHandler, makeReq({ token, method: 'POST' })),
    ]) {
      expect(res._status).toBe(403);
    }
    expect(await counts()).toEqual(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an integration token → 403 NOT_AVAILABLE_TO_INTEGRATIONS', async () => {
    const { token } = await createIntegrationKey(admin, { accessLevel: 'READ_WRITE' });
    for (const [handler, method, url] of [
      [credentialsHandler, 'GET', '/api/enablebanking/credentials'],
      [credentialsHandler, 'PUT', '/api/enablebanking/credentials'],
      [credentialsHandler, 'DELETE', '/api/enablebanking/credentials'],
      [verifyHandler, 'POST', '/api/enablebanking/credentials/verify'],
    ] as const) {
      const res = await call(handler, makeReq({ headers: bearer(token), method, url, body: { appId: APP_A, privateKey: PEM_2048 } }));
      expect(res._status).toBe(403);
      expect(res._body.code).toBe('NOT_AVAILABLE_TO_INTEGRATIONS');
    }
  });

  it('GET before setup: not configured, with the callback URL to register', async () => {
    const res = await get();
    expect(res._status).toBe(200);
    expect(res._body).toEqual({
      configured: false,
      callbackUrl: CALLBACK,
      credential: null,
      usage: { activeConnections: 0, pausedConnections: 0, linkedAccounts: 0, limit: 5 },
      history: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Save (PUT)
// ---------------------------------------------------------------------------

describe('PUT validation (nothing stored on any rejection)', () => {
  it('rejects a non-UUID app id', async () => {
    const res = await put({ appId: 'my-app', privateKey: PEM_2048 });
    expect(res._status).toBe(400);
    expect(res._body.code).toBe('INVALID_APP_ID');
  });

  const rejected = Object.entries(TEST_KEY_MANIFEST).filter(([, e]) => !e.ok);
  it.each(rejected)('rejects %s with its format code before any network call', async (file, expected) => {
    const res = await put({ appId: APP_A, privateKey: readTestKey(file) });
    expect(res._status).toBe(400);
    expect(res._body.code).toBe(expected.code);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await counts()).toEqual({ credentials: 0, events: 0 });
  });

  it('a key that Enable Banking rejects → 422 INVALID_CREDENTIALS, no row, no history', async () => {
    routes['/application'] = () => ({ status: 401, body: { error: 'UNAUTHORIZED' } });
    const res = await put({ appId: APP_A, privateKey: PEM_2048 });
    expect(res._status).toBe(422);
    expect(res._body.code).toBe('INVALID_CREDENTIALS');
    expect(await counts()).toEqual({ credentials: 0, events: 0 });
  });

  it('a sandbox app → 422 SANDBOX_APP', async () => {
    routes['/application'] = () => ({ status: 200, body: { environment: 'SANDBOX' } });
    const res = await put({ appId: APP_A, privateKey: PEM_2048 });
    expect(res._status).toBe(422);
    expect(res._body.code).toBe('SANDBOX_APP');
    expect(await counts()).toEqual({ credentials: 0, events: 0 });
  });
});

describe('PUT set → rotate', () => {
  it('Enable Banking unreachable → stored as UNVERIFIED', async () => {
    routes['/application'] = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    const res = await put({ appId: APP_A, privateKey: PEM_2048 });
    expect(res._status).toBe(201);
    expect(res._body.credential).toMatchObject({ status: 'UNVERIFIED', lastValidatedAt: null, callbackRegistered: null });
    await prisma.enableBankingCredential.deleteMany({ where: { tenantId: admin.tenantId } });
    await prisma.enableBankingCredentialEvent.deleteMany({ where: { tenantId: admin.tenantId } });
  });

  it('first Set: 201 Verified with fingerprint, a SET history entry, no key in the response', async () => {
    const res = await put({ appId: APP_A, privateKey: PEM_4096 });
    expect(res._status).toBe(201);
    expect(res._body.configured).toBe(true);
    expect(res._body.credential).toMatchObject({
      appId: APP_A, status: 'VERIFIED', keyBits: 4096, callbackRegistered: true,
      keyFingerprint: expect.stringMatching(/^SHA256:.{16}$/), lastValidatedAt: expect.any(Date),
    });
    expect(res._body.credential).not.toHaveProperty('privateKey');
    expect(res._body.history).toEqual([expect.objectContaining({
      action: 'SET', appId: APP_A, keyFingerprint: res._body.credential.keyFingerprint, user: expect.objectContaining({ id: admin.userId }),
    })]);
    expect(JSON.stringify(res._body)).not.toContain('PRIVATE KEY');
    expect(signedWith).toEqual([{ path: '/application', kid: APP_A }]);

    // Stored encrypted; decrypts to the normalised PKCS#8 PEM.
    const [raw] = await prisma.$queryRaw<any[]>`SELECT "privateKey", "appId" FROM "EnableBankingCredential" WHERE "tenantId" = ${admin.tenantId}`;
    expect(raw.privateKey).not.toContain('PRIVATE KEY');
    expect(raw.appId).not.toBe(APP_A);

    // Available to every role at once, without a restart.
    expect((await call(statusHandler, makeReq({ token: memberToken })))._body).toEqual({ enabled: true, configurable: false, pausedConnections: 0 });
  });

  it('the same key as multi-line, CRLF, PKCS#1 or \\n-escaped gives the same fingerprint (no new history entry)', async () => {
    const fingerprint = (await get())._body.credential.keyFingerprint;
    for (const file of ['rsa4096-crlf.pem', 'rsa4096-escaped.txt', 'rsa4096-pkcs1.pem']) {
      const res = await put({ appId: APP_A, privateKey: readTestKey(file) });
      expect(res._status).toBe(200);
      expect(res._body.credential.keyFingerprint).toBe(fingerprint);
    }
    expect((await get())._body.history).toHaveLength(1);
  });

  it('a new key for the same app: KEY_ROTATED, connections stay ACTIVE, the client is rebuilt', async () => {
    const item = await ebItem(admin.tenantId, admin.userId);
    const before = await prisma.enableBankingCredential.findUnique({ where: { tenantId: admin.tenantId } });
    const res = await put({ appId: APP_A, privateKey: PEM_2048 });
    expect(res._status).toBe(200);
    expect(res._body.credential.keyBits).toBe(2048);
    expect(res._body.history[0]).toMatchObject({ action: 'KEY_ROTATED', appId: APP_A });
    expect((await prisma.plaidItem.findUnique({ where: { id: item.id } }))!.status).toBe('ACTIVE');
    const after = await prisma.enableBankingCredential.findUnique({ where: { tenantId: admin.tenantId } });
    expect(after!.version).toBe(before!.version + 1);
    await prisma.plaidItem.delete({ where: { id: item.id } });
  });
});

// ---------------------------------------------------------------------------
// App change, remove, re-verify
// ---------------------------------------------------------------------------

describe('app change (R4)', () => {
  it('needs confirmation, then moves live connections to LOGIN_REQUIRED and notifies their users', async () => {
    const { userId: memberId, token } = await createTenantUser(admin.tenantId, 'member');
    const a = await ebItem(admin.tenantId, admin.userId);
    const b = await ebItem(admin.tenantId, memberId, 'ERROR');
    const revoked = await ebItem(admin.tenantId, admin.userId, 'REVOKED');

    const refused = await put({ appId: APP_B, privateKey: PEM_2048 });
    expect(refused._status).toBe(409);
    expect(refused._body).toMatchObject({ code: 'CONFIRMATION_REQUIRED', affectedConnections: 2 });
    expect(fetchMock).not.toHaveBeenCalled();

    const res = await put({ appId: APP_B, privateKey: PEM_2048, confirmAppChange: true });
    expect(res._status).toBe(200);
    expect(res._body.credential.appId).toBe(APP_B);
    expect(res._body.history[0]).toMatchObject({ action: 'REPLACED', appId: APP_B });
    for (const id of [a.id, b.id]) {
      expect(await prisma.plaidItem.findUnique({ where: { id } })).toMatchObject({ status: 'LOGIN_REQUIRED', errorCode: 'APP_CHANGED' });
    }
    expect((await prisma.plaidItem.findUnique({ where: { id: revoked.id } }))!.status).toBe('REVOKED');

    // The authorising member is told to reconnect.
    const summary = await call(summaryHandler, makeReq({ token }));
    expect(summary._body.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'PLAID_ACTION_REQUIRED', label: 'Revolut needs to be re-connected' }),
    ]));
    // Connections are restored to ACTIVE for the next steps.
    await prisma.plaidItem.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { status: 'ACTIVE', errorCode: null } });
  });
});

describe('remove (R4/R8)', () => {
  it('needs confirmation when connections exist; then pauses them, keeps data and records REMOVED', async () => {
    const live = await prisma.plaidItem.count({ where: { tenantId: admin.tenantId, provider: 'ENABLE_BANKING', status: { not: 'REVOKED' } } });
    const refused = await del(false);
    expect(refused._status).toBe(409);
    expect(refused._body).toMatchObject({ code: 'CONFIRMATION_REQUIRED', affectedConnections: live });

    const itemsBefore = await prisma.plaidItem.findMany({ where: { tenantId: admin.tenantId }, orderBy: { id: 'asc' } });
    const res = await del(true);
    expect(res._status).toBe(204);
    expect(await prisma.plaidItem.findMany({ where: { tenantId: admin.tenantId }, orderBy: { id: 'asc' } })).toEqual(itemsBefore);

    const view = (await get())._body;
    expect(view).toMatchObject({ configured: false, credential: null, usage: expect.objectContaining({ pausedConnections: live }) });
    expect(view.history[0]).toMatchObject({ action: 'REMOVED', appId: APP_B });
    expect((await call(statusHandler, makeReq({ token: memberToken })))._body).toEqual({ enabled: false, configurable: false, pausedConnections: live });
    expect((await call(aspspsHandler, makeReq({ token: admin.token })))._body.code).toBe('NOT_ENABLED');
    expect((await del(true))._status).toBe(404);
  });

  it('setting a different app after a remove counts as an app change', async () => {
    const live = await prisma.plaidItem.count({ where: { tenantId: admin.tenantId, provider: 'ENABLE_BANKING', status: { in: ['ACTIVE', 'ERROR'] } } });
    expect(live).toBe(2);
    const refused = await put({ appId: APP_A, privateKey: PEM_2048 });
    expect(refused._status).toBe(409);
    const res = await put({ appId: APP_A, privateKey: PEM_2048, confirmAppChange: true });
    expect(res._status).toBe(201);
    expect(res._body.history[0]).toMatchObject({ action: 'SET', appId: APP_A });
    expect(await prisma.plaidItem.count({ where: { tenantId: admin.tenantId, status: 'LOGIN_REQUIRED', errorCode: 'APP_CHANGED' } })).toBe(live);
  });

  it('setting the same app after a remove resumes the connections untouched', async () => {
    await prisma.plaidItem.updateMany({ where: { tenantId: admin.tenantId, status: 'LOGIN_REQUIRED' }, data: { status: 'ACTIVE', errorCode: null } });
    expect((await del(true))._status).toBe(204);
    const res = await put({ appId: APP_A, privateKey: PEM_2048 });
    expect(res._status).toBe(201);
    expect(await prisma.plaidItem.count({ where: { tenantId: admin.tenantId, status: 'LOGIN_REQUIRED' } })).toBe(0);
  });
});

describe('re-verify', () => {
  it('marks INVALID (admins notified), then VERIFIED again; no history entries', async () => {
    const events = (await counts()).events;
    routes['/application'] = () => ({ status: 403, body: {} });
    const bad = await call(verifyHandler, makeReq({ token: admin.token, method: 'POST' }));
    expect(bad._status).toBe(200);
    expect(bad._body.credential.status).toBe('INVALID');
    const row = await prisma.enableBankingCredential.findUnique({ where: { tenantId: admin.tenantId } });
    expect(row!.invalidatedAt).toBeInstanceOf(Date);

    const adminSignals = (await call(summaryHandler, makeReq({ token: admin.token })))._body.signals;
    expect(adminSignals).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'ENABLE_BANKING_CREDENTIALS_INVALID', href: '/settings?tab=bank-sync' })]));
    const memberSignals = (await call(summaryHandler, makeReq({ token: memberToken })))._body.signals;
    expect(memberSignals.some((s: any) => s.type === 'ENABLE_BANKING_CREDENTIALS_INVALID')).toBe(false);

    routes['/application'] = appOk;
    const good = await call(verifyHandler, makeReq({ token: admin.token, method: 'POST' }));
    expect(good._body.credential.status).toBe('VERIFIED');
    expect((await prisma.enableBankingCredential.findUnique({ where: { tenantId: admin.tenantId } }))!.invalidatedAt).toBeNull();
    expect((await counts()).events).toBe(events);
  });

  it('unreachable → UNVERIFIED', async () => {
    routes['/application'] = () => ({ status: 503 });
    const res = await call(verifyHandler, makeReq({ token: admin.token, method: 'POST' }));
    expect(res._body.credential.status).toBe('UNVERIFIED');
  });
});

describe('history', () => {
  it('shows the 10 most recent changes, newest first', async () => {
    const base = Date.now() + 60_000;
    for (let i = 0; i < 12; i++) {
      await prisma.enableBankingCredentialEvent.create({
        data: { tenantId: admin.tenantId, action: 'KEY_ROTATED', appId: APP_A, appIdHash: 'x', keyFingerprint: `SHA256:${i}`, createdAt: new Date(base + i * 1000) },
      });
    }
    const history = (await get())._body.history;
    expect(history).toHaveLength(10);
    expect(history[0].keyFingerprint).toBe('SHA256:11');
    expect(history[9].keyFingerprint).toBe('SHA256:2');
  });
});

// ---------------------------------------------------------------------------
// Isolation and leaks
// ---------------------------------------------------------------------------

describe('tenant isolation (R3)', () => {
  it('every call of a tenant is signed with its own app', async () => {
    const other = await createIsolatedTenant('eb-credentials-b');
    try {
      await saveTestCredential(other.tenantId, { appId: APP_B, keyFile: 'rsa4096-pkcs8.pem' });
      const redis = createFakeRedis();
      __setRedisClientForTests(redis as any);
      await prisma.country.upsert({ where: { id: 'ESP' }, update: { iso2: 'ES' }, create: { id: 'ESP', iso2: 'ES', name: 'Spain' } });
      for (const t of [admin, other]) {
        await prisma.tenantCountry.upsert({
          where: { tenantId_countryId: { tenantId: t.tenantId, countryId: 'ESP' } },
          update: {},
          create: { tenantId: t.tenantId, countryId: 'ESP', isDefault: true },
        });
      }
      routes['/aspsps'] = () => ({ status: 200, body: { aspsps: [{ name: 'Revolut', country: 'ES', maximum_consent_validity: 90 * 86400 }] } });
      routes['/auth'] = () => ({ status: 200, body: { url: 'https://bank.example/consent' } });

      await call(aspspsHandler, makeReq({ token: admin.token }));
      await call(connectHandler, makeReq({ token: admin.token, method: 'POST', body: { aspspName: 'Revolut', aspspCountry: 'ES' } }));
      const aCalls = signedWith.splice(0);
      await call(aspspsHandler, makeReq({ token: other.token }));
      await call(connectHandler, makeReq({ token: other.token, method: 'POST', body: { aspspName: 'Revolut', aspspCountry: 'ES' } }));
      const bCalls = signedWith.splice(0);

      expect(aCalls.map((c) => c.path)).toEqual(['/aspsps', '/aspsps', '/auth']);
      expect(new Set(aCalls.map((c) => c.kid))).toEqual(new Set([APP_A]));
      expect(new Set(bCalls.map((c) => c.kid))).toEqual(new Set([APP_B]));
    } finally {
      await prisma.tenantCountry.deleteMany({ where: { tenantId: { in: [admin.tenantId, other.tenantId] } } });
      await teardownTenant(other.tenantId);
    }
  });
});

describe('no key leaks (R7)', () => {
  it('no response, log line, Sentry call or history row carries key material', async () => {
    const history = await prisma.enableBankingCredentialEvent.findMany({ where: { tenantId: admin.tenantId } });
    const haystack = [
      JSON.stringify(responses),
      consoleLines.join('\n'),
      JSON.stringify(mockCaptureException.mock.calls),
      JSON.stringify(history),
    ].join('\n');
    expect(haystack).not.toContain('PRIVATE KEY');
    for (const pem of [PEM_2048, PEM_4096]) {
      expect(haystack).not.toContain(pem.split('\n')[1]);
    }
  });
});
