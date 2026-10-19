/**
 * Integration tests for the Enable Banking routes (#132), end to end against
 * the real bliss_test database:
 *
 *   status / aspsps / connect → callback (valid, invalid, tampered, expired,
 *   replayed, denied) → connection GET (R5 suggestions) → map (R5a provider
 *   switch keeps the same Account rows; R6 joint guard) → sync budget (R12)
 *   → reconnect re-attachment (R7) → disconnect, plus the WRONG_PROVIDER
 *   guards on the Plaid-only routes and promotion under the remittance label;
 *   per-tenant credentials (#148): NOT_ENABLED without them and paused
 *   connections, resumed once they are saved again.
 *
 * withAuth is real (JWT cookie). Mocked: rate limiter, produceEvent, Sentry,
 * the Enable Banking HTTP client and Redis (in-memory fake).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

vi.mock('../../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
  createRateLimiter: vi.fn().mockReturnValue((_req: unknown, _res: unknown, next: () => void) => next()),
}));

const { mockProduceEvent } = vi.hoisted(() => ({ mockProduceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../../utils/produceEvent.js', () => ({ produceEvent: mockProduceEvent }));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), init: vi.fn() }));

import prisma from '../../../../prisma/prisma.js';
import { createIsolatedTenant, teardownTenant } from '../../../helpers/tenant.js';
import { createFakeRedis } from '../../../helpers/fakeRedis';
import { __setRedisClientForTests } from '../../../../utils/redisClient.js';
import { __setEnableBankingClientForTests } from '../../../../utils/enableBanking.js';
import { budgetKey, budgetDay } from '@bliss/shared/enablebanking';
import { saveTestCredential, removeTestCredential } from '../../../helpers/enableBanking';

import statusHandler from '../../../../pages/api/enablebanking/status.js';
import aspspsHandler from '../../../../pages/api/enablebanking/aspsps.js';
import connectHandler from '../../../../pages/api/enablebanking/connect.js';
import callbackHandler from '../../../../pages/api/enablebanking/callback.js';
import connectionHandler from '../../../../pages/api/enablebanking/connections/[id].js';
import mapHandler from '../../../../pages/api/enablebanking/connections/[id]/map.js';
import syncHandler from '../../../../pages/api/enablebanking/connections/[id]/sync.js';
import resyncHandler from '../../../../pages/api/plaid/resync.js';
import fetchHistoricalHandler from '../../../../pages/api/plaid/fetch-historical.js';
import plaidDisconnectHandler from '../../../../pages/api/plaid/disconnect.js';
import rotateTokenHandler from '../../../../pages/api/plaid/rotate-token.js';
import syncAccountsHandler from '../../../../pages/api/plaid/sync-accounts.js';
import itemsHandler from '../../../../pages/api/plaid/items.js';
import promoteHandler from '../../../../pages/api/plaid/transactions/[id].js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const JWT_SECRET = process.env.JWT_SECRET_CURRENT || 'test-jwt-secret';
const FRONTEND = 'http://web.test';
const DAY = 24 * 60 * 60 * 1000;
const H_DANIEL = `hash-2693-${Date.now()}`;
const H_JOINT = `hash-4704-${Date.now()}`;
const H_PATRICIA = `hash-8859-${Date.now()}`;

function makeReq(token: string | null, overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'GET',
    headers: {},
    cookies: token ? { token } : {},
    body: {},
    query: {},
    url: '/api/enablebanking',
    ...overrides,
  } as unknown as NextApiRequest;
}

function makeRes() {
  const res: any = { _status: undefined, _body: undefined, _location: undefined, _headers: {} };
  res.status = vi.fn((c: number) => { res._status = c; return res; });
  res.json = vi.fn((b: unknown) => { res._body = b; return res; });
  res.setHeader = vi.fn((k: string, v: unknown) => { res._headers[k] = v; return res; });
  res.end = vi.fn(() => res);
  res.redirect = vi.fn((code: number, url: string) => { res._status = code; res._location = url; return res; });
  return res;
}

async function call(handler: any, req: NextApiRequest) {
  const res = makeRes();
  await handler(req, res as unknown as NextApiResponse);
  return res;
}

const redirectQuery = (res: any) => Object.fromEntries(new URL(res._location).searchParams);

// Enable Banking HTTP client stand-in.
const sessions: Record<string, any> = {};
const fakeClient = {
  getAspsps: vi.fn(async (country: string) => (country === 'ES'
    ? [{ name: 'Revolut', country: 'ES', logo: 'https://logo', maximum_consent_validity: 180 * 86400 }]
    : [])),
  startAuth: vi.fn(async () => ({ url: 'https://bank.example/consent', authorization_id: 'auth-1' })),
  createSession: vi.fn(async (code: string) => {
    if (!sessions[code]) throw Object.assign(new Error('bad code'), { status: 400 });
    return sessions[code];
  }),
  deleteSession: vi.fn(async () => ({})),
  getSession: vi.fn(),
  getTransactions: vi.fn(),
  getBalances: vi.fn(),
};

function session(id: string, accounts: Array<{ uid: string; hash: string; iban: string }>) {
  return {
    session_id: id,
    access: { valid_until: new Date(Date.now() + 179 * DAY).toISOString() },
    aspsp: { name: 'Revolut', country: 'ES' },
    accounts: accounts.map((a) => ({
      uid: a.uid, identification_hash: a.hash, account_id: { iban: a.iban }, currency: 'EUR', name: 'Revolut',
    })),
  };
}

let tenantId: string;
let danielId: string;
let danielToken: string;
let patriciaId: string;
let patriciaToken: string;
let redis: ReturnType<typeof createFakeRedis>;
let ref: { bankId: number };
let accDaniel: any; // #3604-like
let accJoint: any; // #3603-like
let accPatricia: any; // #3605-like
let plaidItem: any;
let ebItemId: string;
let patriciaItemId: string;

const env = { ...process.env };

async function startFlow(token: string, body: Record<string, unknown> = { aspspName: 'Revolut', aspspCountry: 'ES' }) {
  const res = await call(connectHandler, makeReq(token, { method: 'POST', body }));
  const state = fakeClient.startAuth.mock.calls.at(-1)?.[0]?.state;
  return { res, state };
}

beforeAll(async () => {
  process.env.NEXTAUTH_SECRET = 'eb-test-secret';
  process.env.NEXTAUTH_URL = 'https://api.example.test';
  process.env.FRONTEND_URL = FRONTEND;
  delete process.env.ENABLE_BANKING_REDIRECT_URL;

  const t = await createIsolatedTenant('enablebanking');
  tenantId = t.tenantId;
  danielId = t.userId;
  danielToken = t.token;
  await saveTestCredential(tenantId); // the client itself is faked below
  const patricia = await prisma.user.create({
    data: { email: `patricia-${Date.now()}@test.bliss`, tenantId, role: 'member' },
  });
  patriciaId = patricia.id;
  patriciaToken = jwt.sign({ jti: uuidv4(), userId: patriciaId, tenantId }, JWT_SECRET, { expiresIn: '1h' });

  await prisma.country.upsert({ where: { id: 'ESP' }, update: { iso2: 'ES' }, create: { id: 'ESP', iso2: 'ES', name: 'Spain' } });
  await prisma.currency.upsert({ where: { id: 'EUR' }, update: {}, create: { id: 'EUR', name: 'Euro' } });
  const bank = await prisma.bank.upsert({ where: { name: 'Revolut' }, update: {}, create: { name: 'Revolut' } });
  ref = { bankId: bank.id };
  await prisma.tenantCountry.create({ data: { tenantId, countryId: 'ESP', isDefault: true } });
  await prisma.tenant.update({ where: { id: tenantId }, data: { plaidHistoryDays: 1 } });

  // The household's existing accounts; Daniel's and the joint one are Plaid-linked.
  plaidItem = await prisma.plaidItem.create({
    data: { tenantId, userId: danielId, itemId: `plaid-item-${Date.now()}`, accessToken: 'access-plaid', institutionName: 'Revolut', status: 'ACTIVE' },
  });
  const base = { bankId: ref.bankId, countryId: 'ESP', currencyCode: 'EUR', tenantId };
  accDaniel = await prisma.account.create({ data: { ...base, name: 'Revolut Daniel', accountNumber: 'ES00 0000 0000 0000 0000 2693', plaidAccountId: 'plaid-acc-d', plaidItemId: plaidItem.id, mask: '2693' } });
  accJoint = await prisma.account.create({ data: { ...base, name: 'Revolut Joint', accountNumber: 'ES00 0000 0000 0000 0000 4704', plaidAccountId: 'plaid-acc-j', plaidItemId: plaidItem.id, mask: '4704' } });
  accPatricia = await prisma.account.create({ data: { ...base, name: 'Revolut Patricia', accountNumber: 'ES00 0000 0000 0000 0000 8859' } });
  // History that must survive the provider switch.
  const groceries = await prisma.category.create({ data: { name: 'Groceries', group: 'Food', type: 'Essentials', tenantId } });
  await prisma.transaction.create({
    data: {
      categoryId: groceries.id,
      transaction_date: new Date('2026-10-10'), year: 2026, quarter: 'Q4', month: 10, day: 10,
      description: 'Caprabo', debit: 4.78, currency: 'EUR', accountId: accJoint.id, tenantId, source: 'PLAID', externalId: `plaid-tx-${Date.now()}`,
    },
  });

  sessions['code-daniel'] = session('sess-daniel-1', [
    { uid: 'uid-d-1', hash: H_DANIEL, iban: 'ES0000000000000000002693' },
    { uid: 'uid-j-1', hash: H_JOINT, iban: 'ES0000000000000000004704' },
  ]);
  // Patricia's consent wrongly includes the joint account too (R6 guard).
  sessions['code-patricia'] = session('sess-patricia-1', [
    { uid: 'uid-p-1', hash: H_PATRICIA, iban: 'ES0000000000000000008859' },
    { uid: 'uid-pj-1', hash: H_JOINT, iban: 'ES0000000000000000004704' },
  ]);
  sessions['code-daniel-reconnect'] = session('sess-daniel-2', [
    { uid: 'uid-d-2', hash: H_DANIEL, iban: 'ES0000000000000000002693' },
    { uid: 'uid-j-2', hash: H_JOINT, iban: 'ES0000000000000000004704' },
  ]);
});

beforeEach(() => {
  redis = redis || createFakeRedis();
  __setRedisClientForTests(redis as any);
  __setEnableBankingClientForTests(fakeClient as any);
  mockProduceEvent.mockClear();
});

afterAll(async () => {
  __setRedisClientForTests(null as any);
  __setEnableBankingClientForTests(null as any);
  process.env = { ...env };
  // TenantCountry does not cascade from Tenant.
  await prisma.tenantCountry.deleteMany({ where: { tenantId } });
  await teardownTenant(tenantId);
});

// ---------------------------------------------------------------------------
// Tests (ordered: each step builds on the previous)
// ---------------------------------------------------------------------------

describe('feature flag (per-tenant credentials, #148)', () => {
  it('reports enabled for every role, configurable for admins only', async () => {
    expect((await call(statusHandler, makeReq(danielToken)))._body).toEqual({ enabled: true, configurable: true, pausedConnections: 0 });
    expect((await call(statusHandler, makeReq(patriciaToken)))._body).toEqual({ enabled: true, configurable: false, pausedConnections: 0 });
  });

  it('hides everything for a tenant without credentials, whatever the env says', async () => {
    process.env.ENABLE_BANKING_APP_ID = 'retired-app';
    process.env.ENABLE_BANKING_PRIVATE_KEY = 'retired-key';
    await removeTestCredential(tenantId);
    try {
      expect((await call(statusHandler, makeReq(danielToken)))._body).toEqual({ enabled: false, configurable: true, pausedConnections: 0 });
      const aspsps = await call(aspspsHandler, makeReq(danielToken));
      expect(aspsps._status).toBe(404);
      expect(aspsps._body.code).toBe('NOT_ENABLED');
      expect((await call(connectHandler, makeReq(danielToken, { method: 'POST', body: { aspspName: 'Revolut', aspspCountry: 'ES' } })))._status).toBe(404);
      expect(fakeClient.getAspsps).not.toHaveBeenCalled();
    } finally {
      delete process.env.ENABLE_BANKING_APP_ID;
      delete process.env.ENABLE_BANKING_PRIVATE_KEY;
      await saveTestCredential(tenantId);
    }
  });
});

describe('connect', () => {
  it('lists banks for the tenant countries with the computed start date', async () => {
    const res = await call(aspspsHandler, makeReq(danielToken));
    expect(res._status).toBe(200);
    expect(fakeClient.getAspsps).toHaveBeenCalledWith('ES');
    expect(res._body.aspsps).toEqual([{ name: 'Revolut', country: 'ES', logo: 'https://logo', maximumConsentValiditySec: 180 * 86400 }]);
    const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
    expect(res._body.startDate).toBe(yesterday);
  });

  it('starts POST /auth with a near-maximum consent, personal PSU, the callback URL and a signed state', async () => {
    const { res, state } = await startFlow(danielToken);
    expect(res._status).toBe(200);
    expect(res._body.url).toBe('https://bank.example/consent');
    const body = fakeClient.startAuth.mock.calls.at(-1)![0];
    expect(body).toMatchObject({
      aspsp: { name: 'Revolut', country: 'ES' },
      psu_type: 'personal',
      redirect_url: 'https://api.example.test/api/enablebanking/callback',
    });
    const validFor = new Date(body.access.valid_until).getTime() - Date.now();
    expect(validFor).toBeGreaterThan(178.9 * DAY);
    expect(validFor).toBeLessThan(179.1 * DAY);
    expect(typeof state).toBe('string');
  });

  it('rejects a country the tenant has not enabled', async () => {
    const res = await call(connectHandler, makeReq(danielToken, { method: 'POST', body: { aspspName: 'Revolut', aspspCountry: 'FR' } }));
    expect(res._status).toBe(400);
    expect(res._body.code).toBe('COUNTRY_NOT_ENABLED');
  });
});

describe('callback state validation', () => {
  async function itemCount() {
    return prisma.plaidItem.count({ where: { tenantId, provider: 'ENABLE_BANKING' } });
  }

  it.each([
    ['missing', () => undefined],
    ['tampered', async () => {
      const { state } = await startFlow(danielToken);
      const [p, s] = state.split('.');
      const body = JSON.parse(Buffer.from(p, 'base64url').toString());
      return `${Buffer.from(JSON.stringify({ ...body, u: patriciaId })).toString('base64url')}.${s}`;
    }],
    ['expired', async () => {
      const { signState } = await import('../../../../utils/enableBanking.js');
      return signState({ tenantId, userId: danielId, now: Date.now() - 16 * 60 * 1000 });
    }],
  ])('%s state: nothing exchanged, nothing persisted, error page', async (_label, makeState) => {
    const before = await itemCount();
    fakeClient.createSession.mockClear();
    const state = await (makeState as any)();
    const res = await call(callbackHandler, makeReq(null, { query: { code: 'code-daniel', ...(state && { state }) } }));
    expect(res._status).toBe(302);
    expect(res._location.startsWith(`${FRONTEND}/accounts?`)).toBe(true);
    expect(redirectQuery(res)).toEqual({ eb_error: 'invalid_state' });
    expect(fakeClient.createSession).not.toHaveBeenCalled();
    expect(await itemCount()).toBe(before);
  });

  it('denied consent redirects with eb_error=denied', async () => {
    const { state } = await startFlow(danielToken);
    const res = await call(callbackHandler, makeReq(null, { query: { error: 'access_denied', state } }));
    expect(redirectQuery(res)).toEqual({ eb_error: 'denied' });
  });

  it('a signed-in browser of another user is refused', async () => {
    const { state } = await startFlow(danielToken);
    const res = await call(callbackHandler, makeReq(patriciaToken, { query: { code: 'code-daniel', state } }));
    expect(redirectQuery(res)).toEqual({ eb_error: 'invalid_state' });
  });
});

describe('callback + mapping (Daniel)', () => {
  it('exchanges the code, persists connection and accounts, and redirects to the mapping step (never /auth/login)', async () => {
    const { state } = await startFlow(danielToken);
    const res = await call(callbackHandler, makeReq(null, { query: { code: 'code-daniel', state } }));
    expect(res._status).toBe(302);
    expect(res._location).not.toMatch(/auth\/login/);
    const q = redirectQuery(res);
    expect(q.eb).toBe('map');
    ebItemId = q.connection;

    const item = await prisma.plaidItem.findUnique({ where: { id: ebItemId } });
    const ebAccounts = await prisma.enableBankingAccount.findMany({ where: { plaidItemId: ebItemId } });
    expect(item).toMatchObject({
      tenantId, userId: danielId, provider: 'ENABLE_BANKING', status: 'PENDING_SELECTION',
      institutionName: 'Revolut', aspspCountry: 'ES', accessToken: 'sess-daniel-1',
    });
    expect(item!.itemId.startsWith('eb_')).toBe(true);
    expect(item!.consentExpiration!.getTime() - Date.now()).toBeGreaterThan(178 * DAY);
    expect(ebAccounts.map((a) => [a.ibanLast4, a.uid, a.iban, a.accountId]).sort()).toEqual([
      ['2693', 'uid-d-1', 'ES0000000000000000002693', null],
      ['4704', 'uid-j-1', 'ES0000000000000000004704', null],
    ]);
    // The IBAN is stored encrypted.
    const raw: any[] = await prisma.$queryRaw`SELECT "iban" FROM "EnableBankingAccount" WHERE "plaidItemId" = ${ebItemId}`;
    expect(raw.every((r) => !String(r.iban).includes('ES000000'))).toBe(true);
  });

  it('a replayed state is refused', async () => {
    const { state } = await startFlow(danielToken);
    await call(callbackHandler, makeReq(null, { query: { code: 'code-daniel', state } }));
    fakeClient.createSession.mockClear();
    const replay = await call(callbackHandler, makeReq(null, { query: { code: 'code-daniel', state } }));
    expect(redirectQuery(replay)).toEqual({ eb_error: 'invalid_state' });
    expect(fakeClient.createSession).not.toHaveBeenCalled();
    // Clean up the extra connection the first use created.
    const extra = await prisma.plaidItem.findMany({ where: { tenantId, provider: 'ENABLE_BANKING', id: { not: ebItemId } } });
    await prisma.plaidItem.deleteMany({ where: { id: { in: extra.map((e) => e.id) } } });
  });

  it('pre-matches accounts by last 4 and reports Plaid links and the start date', async () => {
    const res = await call(connectionHandler, makeReq(danielToken, { query: { id: ebItemId } }));
    expect(res._status).toBe(200);
    const byLast4 = Object.fromEntries(res._body.accounts.map((a: any) => [a.ibanLast4, a]));
    expect(byLast4['2693'].suggestedAccountId).toBe(accDaniel.id);
    expect(byLast4['4704'].suggestedAccountId).toBe(accJoint.id);
    expect(byLast4['4704'].conflict).toBe(false);
    const joint = res._body.blissAccounts.find((b: any) => b.id === accJoint.id);
    expect(joint).toMatchObject({ linkedProvider: 'PLAID', last4: '4704' });
    expect(JSON.stringify(res._body)).not.toContain('ES00 0000');
    expect(res._body.startDate).toBe(new Date(new Date(res._body.connection.createdAt).getTime() - DAY).toISOString().slice(0, 10));
  });

  it('requires a confirmed provider switch for Plaid-linked targets', async () => {
    const conn = (await call(connectionHandler, makeReq(danielToken, { query: { id: ebItemId } })))._body;
    const mappings = conn.accounts.map((a: any) => ({ ebAccountId: a.id, accountId: a.suggestedAccountId }));
    const res = await call(mapHandler, makeReq(danielToken, { method: 'POST', query: { id: ebItemId }, body: { mappings } }));
    expect(res._status).toBe(409);
    expect(res._body.code).toBe('PROVIDER_SWITCH_REQUIRED');
    expect(res._body.accounts.map((a: any) => a.id).sort()).toEqual([accDaniel.id, accJoint.id].sort());
    expect(mockProduceEvent).not.toHaveBeenCalled();
  });

  it('switches the same Account rows to Enable Banking, revokes the emptied Plaid item and starts the first sync', async () => {
    const accountsBefore = await prisma.account.findMany({ where: { tenantId }, select: { id: true }, orderBy: { id: 'asc' } });
    const txBefore = await prisma.transaction.count({ where: { tenantId } });
    const conn = (await call(connectionHandler, makeReq(danielToken, { query: { id: ebItemId } })))._body;
    const mappings = conn.accounts.map((a: any) => ({ ebAccountId: a.id, accountId: a.suggestedAccountId }));

    const res = await call(mapHandler, makeReq(danielToken, { method: 'POST', query: { id: ebItemId }, body: { mappings, confirmProviderSwitch: true } }));
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ mapped: 2, created: 0, switched: 2 });

    expect(await prisma.account.findMany({ where: { tenantId }, select: { id: true }, orderBy: { id: 'asc' } })).toEqual(accountsBefore);
    expect(await prisma.transaction.count({ where: { tenantId } })).toBe(txBefore);
    const joint = await prisma.account.findUnique({ where: { id: accJoint.id } });
    expect(joint).toMatchObject({ plaidAccountId: `eb:${H_JOINT}`, plaidItemId: ebItemId });
    expect((await prisma.plaidItem.findUnique({ where: { id: plaidItem.id } }))!.status).toBe('REVOKED');
    expect((await prisma.plaidItem.findUnique({ where: { id: ebItemId } }))!.status).toBe('ACTIVE');
    expect(mockProduceEvent).toHaveBeenCalledWith({ type: 'ENABLE_BANKING_SYNC', tenantId, plaidItemId: ebItemId, source: 'INITIAL' });
  });
});

describe('mapping guards', () => {
  it('refuses to point a second bank account at a Bliss account already fed by this connection', async () => {
    const conn = (await call(connectionHandler, makeReq(danielToken, { query: { id: ebItemId } })))._body;
    const daniel = conn.accounts.find((a: any) => a.ibanLast4 === '2693');
    const res = await call(mapHandler, makeReq(danielToken, {
      method: 'POST', query: { id: ebItemId }, body: { mappings: [{ ebAccountId: daniel.id, accountId: accJoint.id }] },
    }));
    expect(res._status).toBe(400);
    expect(res._body.code).toBe('DUPLICATE_TARGET');
  });

  it('validates the body shape', async () => {
    const bad = await call(mapHandler, makeReq(danielToken, { method: 'POST', query: { id: ebItemId }, body: { mappings: [{ ebAccountId: 'x', accountId: 1, skip: true }] } }));
    expect(bad._status).toBe(400);
    const empty = await call(mapHandler, makeReq(danielToken, { method: 'POST', query: { id: ebItemId }, body: { mappings: [] } }));
    expect(empty._status).toBe(400);
  });
});

describe('joint-account guard (R6) and Patricia', () => {
  it('flags and refuses a second mapping of the joint account through another consent', async () => {
    const { state } = await startFlow(patriciaToken);
    const cb = await call(callbackHandler, makeReq(null, { query: { code: 'code-patricia', state } }));
    patriciaItemId = redirectQuery(cb).connection;

    const conn = (await call(connectionHandler, makeReq(patriciaToken, { query: { id: patriciaItemId } })))._body;
    const byLast4 = Object.fromEntries(conn.accounts.map((a: any) => [a.ibanLast4, a]));
    expect(byLast4['4704'].conflict).toBe(true);
    expect(byLast4['8859']).toMatchObject({ conflict: false, suggestedAccountId: accPatricia.id });

    const refused = await call(mapHandler, makeReq(patriciaToken, {
      method: 'POST', query: { id: patriciaItemId },
      body: { mappings: [{ ebAccountId: byLast4['4704'].id, accountId: accJoint.id }], confirmProviderSwitch: true },
    }));
    expect(refused._status).toBe(409);
    expect(refused._body.code).toBe('ACCOUNT_ALREADY_CONNECTED');

    const ok = await call(mapHandler, makeReq(patriciaToken, {
      method: 'POST', query: { id: patriciaItemId },
      body: { mappings: [
        { ebAccountId: byLast4['8859'].id, accountId: accPatricia.id },
        { ebAccountId: byLast4['4704'].id, skip: true },
      ] },
    }));
    expect(ok._status).toBe(200);
    expect(ok._body).toMatchObject({ mapped: 1, skipped: 1, switched: 0 });
    expect((await prisma.plaidItem.findUnique({ where: { id: patriciaItemId } }))).toMatchObject({ userId: patriciaId, status: 'ACTIVE' });
    // The joint account still belongs to Daniel's connection.
    expect((await prisma.account.findUnique({ where: { id: accJoint.id } }))!.plaidItemId).toBe(ebItemId);
  });

  it('the database itself refuses a second active mapping of the same bank account (partial unique index)', async () => {
    const jointOnDaniel = await prisma.enableBankingAccount.findFirst({ where: { plaidItemId: ebItemId, identificationHash: H_JOINT } });
    const jointOnPatricia = await prisma.enableBankingAccount.findFirst({ where: { plaidItemId: patriciaItemId, identificationHash: H_JOINT } });
    expect(jointOnDaniel!.accountId).toBe(accJoint.id);
    await expect(prisma.enableBankingAccount.update({
      where: { id: jointOnPatricia!.id }, data: { accountId: accJoint.id },
    })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('only creates an Account when asked to', async () => {
    const conn = (await call(connectionHandler, makeReq(patriciaToken, { query: { id: patriciaItemId } })))._body;
    const before = await prisma.account.count({ where: { tenantId } });
    const res = await call(mapHandler, makeReq(patriciaToken, {
      method: 'POST', query: { id: patriciaItemId },
      body: { mappings: [{ ebAccountId: conn.accounts.find((a: any) => a.ibanLast4 === '4704').id, create: { name: 'Dup', bankId: ref.bankId, countryId: 'ESP', currencyCode: 'EUR' } }] },
    }));
    // Creating a new Bliss account for an already-connected bank account is still refused.
    expect(res._status).toBe(409);
    expect(await prisma.account.count({ where: { tenantId } })).toBe(before);

    // An explicit create makes a new Account holding the (decrypted, re-encrypted once) IBAN.
    const own = conn.accounts.find((a: any) => a.ibanLast4 === '8859');
    const created = await call(mapHandler, makeReq(patriciaToken, {
      method: 'POST', query: { id: patriciaItemId },
      body: { mappings: [{ ebAccountId: own.id, create: { name: 'Revolut Patricia (EB)', bankId: ref.bankId, countryId: 'ESP', currencyCode: 'EUR' } }] },
    }));
    expect(created._status).toBe(200);
    expect(created._body).toMatchObject({ created: 1 });
    expect(await prisma.account.count({ where: { tenantId } })).toBe(before + 1);
    const newAccount = await prisma.account.findFirst({ where: { tenantId, name: 'Revolut Patricia (EB)' } });
    expect(newAccount).toMatchObject({ accountNumber: 'ES0000000000000000008859', mask: '8859', plaidAccountId: `eb:${H_PATRICIA}`, plaidItemId: patriciaItemId });
    // The previously mapped account is released from this connection.
    expect(await prisma.account.findUnique({ where: { id: accPatricia.id } })).toMatchObject({ plaidItemId: null, plaidAccountId: null });
  });
});

describe('sync now (R12)', () => {
  it('202 within budget, 429 SYNC_BUDGET_EXHAUSTED once every mapped account is spent', async () => {
    const ok = await call(syncHandler, makeReq(danielToken, { method: 'POST', query: { id: ebItemId } }));
    expect(ok._status).toBe(202);
    expect(mockProduceEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'ENABLE_BANKING_SYNC', plaidItemId: ebItemId }));

    const ebAccounts = await prisma.enableBankingAccount.findMany({ where: { plaidItemId: ebItemId } });
    for (const a of ebAccounts) redis.store.set(budgetKey(a.id, budgetDay(new Date())), '4');
    mockProduceEvent.mockClear();
    const spent = await call(syncHandler, makeReq(danielToken, { method: 'POST', query: { id: ebItemId } }));
    expect(spent._status).toBe(429);
    expect(spent._body.code).toBe('SYNC_BUDGET_EXHAUSTED');
    expect(new Date(spent._body.resetsAt).getTime()).toBeGreaterThan(Date.now());
    expect(mockProduceEvent).not.toHaveBeenCalled();
    for (const a of ebAccounts) redis.store.delete(budgetKey(a.id, budgetDay(new Date())));
  });
});

describe('Plaid-only routes refuse Enable Banking connections', () => {
  it.each([
    ['resync', resyncHandler, { method: 'POST' }],
    ['fetch-historical', fetchHistoricalHandler, { method: 'POST', body: { fromDate: '2025-01-01' } }],
    ['disconnect', plaidDisconnectHandler, { method: 'POST' }],
    ['rotate-token', rotateTokenHandler, { method: 'POST' }],
    ['items PATCH', itemsHandler, { method: 'PATCH', body: { status: 'ACTIVE' } }],
  ])('%s → 400 WRONG_PROVIDER', async (_n, handler, extra: any) => {
    const res = await call(handler, makeReq(danielToken, { ...extra, query: { id: ebItemId } }));
    expect(res._status).toBe(400);
    expect(res._body.code).toBe('WRONG_PROVIDER');
  });

  it('sync-accounts → 400 WRONG_PROVIDER', async () => {
    const res = await call(syncAccountsHandler, makeReq(danielToken, { method: 'POST', body: { plaidItemId: ebItemId, selectedAccountIds: ['x'] } }));
    expect(res._status).toBe(400);
    expect(res._body.code).toBe('WRONG_PROVIDER');
  });

  it('GET /api/plaid/items exposes the provider, country and consent expiry', async () => {
    const res = await call(itemsHandler, makeReq(danielToken));
    const eb = res._body.find((i: any) => i.id === ebItemId);
    expect(eb).toMatchObject({ provider: 'ENABLE_BANKING', aspspCountry: 'ES', userId: danielId });
    expect(eb.consentExpiration).toBeTruthy();
    expect(res._body.find((i: any) => i.id === plaidItem.id).provider).toBe('PLAID');
  });
});

describe('promotion uses the remittance label (D3)', () => {
  it('approving "Taxi Lic 1137" creates a −10.70 EUR transaction described by the remittance', async () => {
    const category = await prisma.category.create({ data: { name: 'Taxi', group: 'Transport', type: 'Essentials', tenantId } });
    const ptx = await prisma.plaidTransaction.create({
      data: {
        plaidItemId: ebItemId, plaidAccountId: `eb:${H_JOINT}`, plaidTransactionId: `eb:${H_JOINT}:taxi-${Date.now()}`,
        amount: 10.7, date: new Date('2026-10-10'), name: 'Taxi Lic 1137', merchantName: 'TAXI LIC 1137 BCN',
        isoCurrencyCode: 'EUR', promotionStatus: 'CLASSIFIED', processed: true, suggestedCategoryId: category.id,
      },
    });
    const res = await call(promoteHandler, makeReq(danielToken, {
      method: 'PUT', query: { id: ptx.id }, body: { promotionStatus: 'PROMOTED', suggestedCategoryId: category.id },
    }));
    expect(res._status).toBe(200);
    const tx = await prisma.transaction.findFirst({ where: { tenantId, externalId: ptx.plaidTransactionId } });
    expect(tx).toMatchObject({ description: 'Taxi Lic 1137', currency: 'EUR', accountId: accJoint.id, source: 'PLAID', credit: null });
    expect(Number(tx!.debit)).toBe(10.7);
  });
});

describe('reconnect (R7) and disconnect', () => {
  it('only the authorising user can reconnect', async () => {
    const res = await call(connectHandler, makeReq(patriciaToken, { method: 'POST', body: { reconnectItemId: ebItemId } }));
    expect(res._status).toBe(403);
  });

  it('re-attaches the new session to the same connection and accounts', async () => {
    // Relative to now: startDate is max(lastSync − 7 days, createdAt − historyDays),
    // so a fixed lastSync stops exercising the overlap branch once the
    // connection's createdAt (today) catches up with it.
    const lastSync = new Date(Date.now() - 2 * DAY);
    const expectedStart = new Date(Date.UTC(lastSync.getUTCFullYear(), lastSync.getUTCMonth(), lastSync.getUTCDate()) - 7 * DAY)
      .toISOString().slice(0, 10);
    await prisma.plaidItem.update({
      where: { id: ebItemId },
      data: { status: 'LOGIN_REQUIRED', lastSync, createdAt: new Date(Date.now() - 30 * DAY) },
    });
    const accountsBefore = await prisma.account.count({ where: { tenantId } });
    const ebBefore = await prisma.enableBankingAccount.findMany({ where: { plaidItemId: ebItemId }, orderBy: { id: 'asc' } });

    const { res: start, state } = await startFlow(danielToken, { reconnectItemId: ebItemId });
    expect(start._status).toBe(200);
    expect(start._body.startDate).toBe(expectedStart); // lastSync − 7 days
    const cb = await call(callbackHandler, makeReq(danielToken, { query: { code: 'code-daniel-reconnect', state } }));
    expect(redirectQuery(cb)).toEqual({ eb: 'reconnected', connection: ebItemId });

    const item = await prisma.plaidItem.findUnique({ where: { id: ebItemId } });
    expect(item).toMatchObject({ status: 'ACTIVE', accessToken: 'sess-daniel-2' });
    const ebAfter = await prisma.enableBankingAccount.findMany({ where: { plaidItemId: ebItemId }, orderBy: { id: 'asc' } });
    expect(ebAfter.map((a) => a.id)).toEqual(ebBefore.map((a) => a.id));
    expect(ebAfter.map((a) => a.uid).sort()).toEqual(['uid-d-2', 'uid-j-2']);
    expect(ebAfter.map((a) => a.accountId)).toEqual(ebBefore.map((a) => a.accountId));
    expect(await prisma.account.count({ where: { tenantId } })).toBe(accountsBefore);
    expect(await prisma.plaidItem.count({ where: { tenantId, provider: 'ENABLE_BANKING' } })).toBe(2);
    expect(mockProduceEvent).toHaveBeenCalledWith({ type: 'ENABLE_BANKING_SYNC', tenantId, plaidItemId: ebItemId, source: 'RECONNECT_SYNC' });
  });

  it('disconnect: a non-authorising member is refused; the authoriser revokes and keeps the data', async () => {
    const refused = await call(connectionHandler, makeReq(patriciaToken, { method: 'DELETE', query: { id: ebItemId } }));
    expect(refused._status).toBe(403);

    fakeClient.deleteSession.mockClear();
    const res = await call(connectionHandler, makeReq(danielToken, { method: 'DELETE', query: { id: ebItemId } }));
    expect(res._status).toBe(204);
    expect(fakeClient.deleteSession).toHaveBeenCalledWith('sess-daniel-2');
    expect((await prisma.plaidItem.findUnique({ where: { id: ebItemId } }))!.status).toBe('REVOKED');
    expect((await prisma.account.findUnique({ where: { id: accJoint.id } }))!.plaidItemId).toBe(ebItemId);
    expect(await prisma.transaction.count({ where: { tenantId } })).toBeGreaterThan(0);
  });

  it('after a disconnect, another consent may map the joint account (the revoked mapping is released)', async () => {
    const conn = (await call(connectionHandler, makeReq(patriciaToken, { query: { id: patriciaItemId } })))._body;
    const joint = conn.accounts.find((a: any) => a.ibanLast4 === '4704');
    expect(joint.conflict).toBe(false);
    const res = await call(mapHandler, makeReq(patriciaToken, {
      method: 'POST', query: { id: patriciaItemId },
      body: { mappings: [{ ebAccountId: joint.id, accountId: accJoint.id }], confirmProviderSwitch: true },
    }));
    expect(res._status).toBe(200);
    expect((await prisma.account.findUnique({ where: { id: accJoint.id } }))!.plaidItemId).toBe(patriciaItemId);
  });
});

describe('paused connections (#148, R6/R8)', () => {
  it('without credentials: connections read as paused, every other route answers NOT_ENABLED', async () => {
    const { res: start, state } = await startFlow(danielToken); // state signed while still enabled
    expect(start._status).toBe(200);
    await removeTestCredential(tenantId);
    try {
      const status = (await call(statusHandler, makeReq(patriciaToken)))._body;
      expect(status).toMatchObject({ enabled: false, configurable: false });
      expect(status.pausedConnections).toBeGreaterThan(0);

      const conn = await call(connectionHandler, makeReq(patriciaToken, { query: { id: patriciaItemId } }));
      expect(conn._status).toBe(200);
      expect(conn._body.connection).toMatchObject({ paused: true, status: 'ACTIVE' });

      const items = (await call(itemsHandler, makeReq(danielToken)))._body;
      const eb = items.filter((i: any) => i.provider === 'ENABLE_BANKING');
      expect(eb.find((i: any) => i.id === patriciaItemId)).toMatchObject({ paused: true });
      expect(eb.find((i: any) => i.id === ebItemId)).toMatchObject({ status: 'REVOKED', paused: false });
      expect(items.find((i: any) => i.provider === 'PLAID')).not.toHaveProperty('paused');

      const id = { id: patriciaItemId };
      for (const res of [
        await call(aspspsHandler, makeReq(danielToken)),
        await call(connectHandler, makeReq(danielToken, { method: 'POST', body: { aspspName: 'Revolut', aspspCountry: 'ES' } })),
        await call(connectionHandler, makeReq(patriciaToken, { method: 'DELETE', query: id })),
        await call(mapHandler, makeReq(patriciaToken, { method: 'POST', query: id, body: { mappings: [] } })),
        await call(syncHandler, makeReq(patriciaToken, { method: 'POST', query: id })),
      ]) {
        expect(res._status).toBe(404);
        expect(res._body.code).toBe('NOT_ENABLED');
      }

      fakeClient.createSession.mockClear();
      const cb = await call(callbackHandler, makeReq(danielToken, { query: { code: 'code-daniel', state } }));
      expect(redirectQuery(cb)).toEqual({ eb_error: 'not_enabled' });
      expect(fakeClient.createSession).not.toHaveBeenCalled();

      // Nothing was written to the paused connection.
      expect((await prisma.plaidItem.findUnique({ where: { id: patriciaItemId } }))!.status).toBe('ACTIVE');
    } finally {
      await saveTestCredential(tenantId);
    }
  });

  it('resumes as soon as credentials exist again', async () => {
    const conn = await call(connectionHandler, makeReq(patriciaToken, { query: { id: patriciaItemId } }));
    expect(conn._body.connection.paused).toBe(false);
    const sync = await call(syncHandler, makeReq(patriciaToken, { method: 'POST', query: { id: patriciaItemId } }));
    expect(sync._status).toBe(202);
  });
});
