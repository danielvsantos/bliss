/**
 * Unit tests for utils/enableBanking.js (#132): signed single-use state (D6),
 * consent validity, callback URL, IBAN last-4 matching (R5), the read-only
 * budget view (D5) and the per-tenant client resolver (#148).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFindUnique } = vi.hoisted(() => ({ mockFindUnique: vi.fn() }));
vi.mock('../../../prisma/prisma.js', () => ({
  default: { enableBankingCredential: { findUnique: mockFindUnique } },
}));

import {
  signState,
  consumeState,
  consentValidUntil,
  getCallbackUrl,
  lastFour,
  suggestAccountId,
  budgetStatus,
  getTenantEnableBanking,
  STATE_TTL_SECONDS,
} from '../../../utils/enableBanking.js';
import { __setRedisClientForTests } from '../../../utils/redisClient.js';
import { budgetKey, budgetDay } from '@bliss/shared/enablebanking';
import { createFakeRedis } from '../../helpers/fakeRedis';

let redis: ReturnType<typeof createFakeRedis>;
const env = { ...process.env };

beforeEach(() => {
  redis = createFakeRedis();
  __setRedisClientForTests(redis as any);
  process.env.NEXTAUTH_SECRET = 'test-nextauth-secret';
});

afterEach(() => {
  __setRedisClientForTests(null as any);
  process.env = { ...env };
});

describe('signed state', () => {
  it('round-trips tenant, user and reconnect id exactly once', async () => {
    const state = await signState({ tenantId: 't1', userId: 'u1', reconnectItemId: 'item-9' });
    expect(await consumeState(state)).toEqual({ tenantId: 't1', userId: 'u1', reconnectItemId: 'item-9' });
    // Replay: the nonce was consumed.
    expect(await consumeState(state)).toBeNull();
  });

  it('rejects a missing, malformed or tampered state', async () => {
    const state = await signState({ tenantId: 't1', userId: 'u1' });
    const [payload, sig] = state.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), t: 'other' })).toString('base64url');
    expect(await consumeState(undefined)).toBeNull();
    expect(await consumeState('garbage')).toBeNull();
    expect(await consumeState(`${forged}.${sig}`)).toBeNull();
    expect(await consumeState(`${payload}.${sig}x`)).toBeNull();
    expect(await consumeState(`${state}.extra`)).toBeNull();
    // The untampered state is still usable (failed attempts did not burn it).
    expect(await consumeState(state)).not.toBeNull();
  });

  it('rejects an expired state', async () => {
    const issued = Date.now() - (STATE_TTL_SECONDS + 5) * 1000;
    const state = await signState({ tenantId: 't1', userId: 'u1', now: issued });
    expect(await consumeState(state)).toBeNull();
  });

  it('rejects a state signed under another secret', async () => {
    const state = await signState({ tenantId: 't1', userId: 'u1' });
    process.env.NEXTAUTH_SECRET = 'rotated';
    expect(await consumeState(state)).toBeNull();
  });

  it('refuses to sign without Redis (single use could not be enforced)', async () => {
    __setRedisClientForTests(null as any);
    delete process.env.REDIS_URL;
    await expect(signState({ tenantId: 't1', userId: 'u1' })).rejects.toThrow('REDIS_UNAVAILABLE');
  });
});

describe('consentValidUntil', () => {
  it('is now + maximum consent − 1 day', () => {
    const now = new Date('2026-10-11T12:00:00Z');
    expect(consentValidUntil(180 * 86400, now).toISOString()).toBe('2027-04-08T12:00:00.000Z');
  });

  it('falls back to 90 days when the bank reports nothing', () => {
    const now = new Date('2026-10-11T12:00:00Z');
    expect(consentValidUntil(null, now).toISOString()).toBe('2027-01-08T12:00:00.000Z');
  });
});

describe('getCallbackUrl / getTenantEnableBanking', () => {
  it('defaults to the NEXTAUTH_URL origin and honours the explicit override', () => {
    delete process.env.ENABLE_BANKING_REDIRECT_URL;
    process.env.NEXTAUTH_URL = 'https://api.example.test/some/path';
    expect(getCallbackUrl()).toBe('https://api.example.test/api/enablebanking/callback');
    process.env.ENABLE_BANKING_REDIRECT_URL = 'https://bliss.local/cb';
    expect(getCallbackUrl()).toBe('https://bliss.local/cb');
  });

  const pem = readFileSync(join(__dirname, '../../../../../packages/shared/test-fixtures/enablebanking-keys/rsa2048-pkcs8.pem'), 'utf8');
  const row = (overrides = {}) => ({
    id: 'cred-1', tenantId: 't1', appId: 'app-1', appIdHash: 'h', privateKey: pem,
    keyFingerprint: 'SHA256:x', keyBits: 2048, status: 'VERIFIED', version: 1, ...overrides,
  });

  it('is null for a tenant without credentials, even with the retired env vars set', async () => {
    process.env.ENABLE_BANKING_APP_ID = 'app';
    process.env.ENABLE_BANKING_PRIVATE_KEY = pem;
    mockFindUnique.mockResolvedValueOnce(null);
    expect(await getTenantEnableBanking('t1')).toBeNull();
    expect(await getTenantEnableBanking(undefined as any)).toBeNull();
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { tenantId: 't1' } });
  });

  it('returns a cached client per credential version and metadata without the key', async () => {
    mockFindUnique.mockResolvedValue(row());
    const a = await getTenantEnableBanking('t1');
    const b = await getTenantEnableBanking('t1');
    expect(a!.client).toBe(b!.client);
    expect(a!.credential).toEqual({ id: 'cred-1', tenantId: 't1', version: 1, status: 'VERIFIED', appIdHash: 'h' });
    expect(JSON.stringify(a!.credential)).not.toContain('PRIVATE KEY');
    mockFindUnique.mockResolvedValue(row({ version: 2 }));
    const c = await getTenantEnableBanking('t1');
    expect(c!.client).not.toBe(a!.client);
  });
});

describe('account matching (R5)', () => {
  const accounts = [
    { id: 3604, accountNumber: 'ES12 3456 0000 0000 0000 2693', mask: null, currencyCode: 'EUR' },
    { id: 3603, accountNumber: 'XXXX', mask: '4704', currencyCode: 'EUR' },
    { id: 3605, accountNumber: '8859', mask: null, currencyCode: 'EUR' },
    { id: 9, accountNumber: '8859', mask: null, currencyCode: 'USD' },
  ];

  it('normalises the last four characters', () => {
    expect(lastFour('ES12 3456 7890 2693')).toBe('2693');
    expect(lastFour('12')).toBeNull();
    expect(lastFour(null)).toBeNull();
  });

  it('pre-selects by last 4 (account number or mask) and currency', () => {
    expect(suggestAccountId({ ibanLast4: '2693', currency: 'EUR' }, accounts)).toBe(3604);
    expect(suggestAccountId({ ibanLast4: '4704', currency: 'EUR' }, accounts)).toBe(3603);
    expect(suggestAccountId({ ibanLast4: '8859', currency: 'EUR' }, accounts)).toBe(3605);
  });

  it('returns null for no match or an ambiguous one', () => {
    expect(suggestAccountId({ ibanLast4: '0000', currency: 'EUR' }, accounts)).toBeNull();
    expect(suggestAccountId({ ibanLast4: '8859', currency: null }, accounts)).toBeNull();
    expect(suggestAccountId({ ibanLast4: null, currency: 'EUR' }, accounts)).toBeNull();
  });
});

describe('budgetStatus', () => {
  it('is exhausted only when every mapped account has spent its budget', async () => {
    const now = new Date('2026-10-11T10:00:00Z');
    const day = budgetDay(now);
    redis.store.set(budgetKey('a', day), '4');
    redis.store.set(budgetKey('b', day), '2');
    expect(await budgetStatus(['a', 'b'], now)).toMatchObject({ exhausted: false, limit: 4, used: { a: 4, b: 2 } });
    redis.store.set(budgetKey('b', day), '4');
    const spent = await budgetStatus(['a', 'b'], now);
    expect(spent.exhausted).toBe(true);
    expect(spent.resetsAt).toBe('2026-10-11T22:00:00.000Z');
  });

  it('treats an unreachable Redis as unknown, not spent', async () => {
    __setRedisClientForTests(null as any);
    delete process.env.REDIS_URL;
    expect((await budgetStatus(['a'])).exhausted).toBe(false);
  });
});
