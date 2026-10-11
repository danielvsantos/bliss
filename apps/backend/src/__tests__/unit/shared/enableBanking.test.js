/**
 * @bliss/shared/enablebanking + @bliss/shared/bank-tx-label (#132):
 * JWT signing, key loading, config, typed errors, balances, the R8 date
 * window and the D5 budget helpers.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    signJwt,
    loadPrivateKey,
    getEnableBankingConfig,
    createClient,
    EnableBankingError,
    pickBalance,
    syncCutoffDate,
    syncDateFrom,
    isoDate,
    budgetDay,
    budgetResetsAt,
    budgetKey,
    getDailyBudget,
    getSyncTimes,
    DEFAULT_SYNC_TIMES,
} = require('@bliss/shared/enablebanking');
const { bankTxLabel } = require('@bliss/shared/bank-tx-label');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

describe('signJwt', () => {
    it('signs an RS256 JWT with the Enable Banking header and claims', () => {
        const token = signJwt({ appId: 'app-123', privateKeyPem: PRIVATE_PEM, now: 1_800_000_000 });
        const [h, c, sig] = token.split('.');
        expect(decode(h)).toEqual({ typ: 'JWT', alg: 'RS256', kid: 'app-123' });
        expect(decode(c)).toEqual({
            iss: 'enablebanking.com',
            aud: 'api.enablebanking.com',
            iat: 1_800_000_000,
            exp: 1_800_003_600,
        });
        const verifier = crypto.createVerify('RSA-SHA256');
        verifier.update(`${h}.${c}`);
        expect(verifier.verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
    });

    it('keeps the TTL at or below 24h', () => {
        const [, c] = signJwt({ appId: 'a', privateKeyPem: PRIVATE_PEM, now: 100 }).split('.');
        const claims = decode(c);
        expect(claims.exp - claims.iat).toBeLessThanOrEqual(24 * 3600);
    });

    it('refuses to sign without an app id or key', () => {
        expect(() => signJwt({ appId: '', privateKeyPem: PRIVATE_PEM })).toThrow(/app id/);
        expect(() => signJwt({ appId: 'a', privateKeyPem: '' })).toThrow(/private key/);
    });
});

describe('loadPrivateKey / getEnableBankingConfig', () => {
    it('accepts a \\n-escaped single-line PEM', () => {
        const escaped = PRIVATE_PEM.replace(/\n/g, '\\n');
        expect(loadPrivateKey({ ENABLE_BANKING_PRIVATE_KEY: escaped })).toBe(PRIVATE_PEM);
    });

    it('reads the key from a path', () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eb-')), 'key.pem');
        fs.writeFileSync(file, PRIVATE_PEM);
        expect(loadPrivateKey({ ENABLE_BANKING_PRIVATE_KEY_PATH: file })).toBe(PRIVATE_PEM);
    });

    it('returns null when nothing is configured', () => {
        expect(loadPrivateKey({})).toBeNull();
    });

    it('is enabled only with both the app id and a key, and flags a half configuration', () => {
        expect(getEnableBankingConfig({})).toMatchObject({ enabled: false, partial: false });
        expect(getEnableBankingConfig({ ENABLE_BANKING_APP_ID: 'a' })).toMatchObject({ enabled: false, partial: true });
        expect(getEnableBankingConfig({ ENABLE_BANKING_PRIVATE_KEY: 'k' })).toMatchObject({ enabled: false, partial: true });
        expect(getEnableBankingConfig({ ENABLE_BANKING_APP_ID: 'a', ENABLE_BANKING_PRIVATE_KEY_PATH: '/k' }))
            .toMatchObject({ enabled: true, partial: false, appId: 'a', baseUrl: 'https://api.enablebanking.com' });
    });
});

describe('createClient', () => {
    function fakeFetch(responses) {
        const calls = [];
        const fn = jest.fn(async (url, init) => {
            calls.push({ url, init });
            const r = responses.shift();
            if (r instanceof Error) throw r;
            return { ok: r.status < 400, status: r.status, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
        });
        fn.calls = calls;
        return fn;
    }

    it('sends the bearer JWT, query parameters and caches the token', async () => {
        const fetchImpl = fakeFetch([
            { status: 200, body: { transactions: [], continuation_key: 'next' } },
            { status: 200, body: { balances: [] } },
        ]);
        const client = createClient({ appId: 'app', privateKey: PRIVATE_PEM, fetchImpl, nowFn: () => 1_800_000_000_000 });
        const page = await client.getTransactions('uid/1', { dateFrom: '2026-10-10', continuationKey: 'k1' });
        await client.getBalances('uid/1');
        expect(page.continuation_key).toBe('next');
        const url = new URL(fetchImpl.calls[0].url);
        expect(url.pathname).toBe('/accounts/uid%2F1/transactions');
        expect(url.searchParams.get('date_from')).toBe('2026-10-10');
        expect(url.searchParams.get('continuation_key')).toBe('k1');
        const auth0 = fetchImpl.calls[0].init.headers.Authorization;
        expect(auth0).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
        expect(fetchImpl.calls[1].init.headers.Authorization).toBe(auth0);
    });

    it('maps errors to EnableBankingError without leaking the JWT', async () => {
        const fetchImpl = fakeFetch([{ status: 401, body: { error: 'EXPIRED_SESSION' } }]);
        const client = createClient({ appId: 'app', privateKey: PRIVATE_PEM, fetchImpl });
        const err = await client.getSession('s1').catch(e => e);
        expect(err).toBeInstanceOf(EnableBankingError);
        expect(err).toMatchObject({ status: 401, code: 'EXPIRED_SESSION', consent: true, retryable: false, rateLimited: false });
        const token = fetchImpl.calls[0].init.headers.Authorization.slice('Bearer '.length);
        expect(err.message).not.toContain(token);
        expect(JSON.stringify(err)).not.toContain(token);
    });

    it('classifies 429, 5xx and network errors as retryable / rate limited', async () => {
        const fetchImpl = fakeFetch([
            { status: 429, body: {} },
            { status: 503 },
            new TypeError('fetch failed'),
        ]);
        const client = createClient({ appId: 'app', privateKey: PRIVATE_PEM, fetchImpl });
        const e429 = await client.getBalances('u').catch(e => e);
        const e503 = await client.getBalances('u').catch(e => e);
        const eNet = await client.getBalances('u').catch(e => e);
        expect(e429).toMatchObject({ rateLimited: true, retryable: true, consent: false });
        expect(e503).toMatchObject({ status: 503, retryable: true, consent: false });
        expect(eNet).toMatchObject({ status: 0, code: 'NETWORK', retryable: true });
    });

    it('treats a 400 with a session error code as a consent failure', () => {
        expect(new EnableBankingError('x', { status: 400, code: 'REVOKED_SESSION' }).consent).toBe(true);
        expect(new EnableBankingError('x', { status: 400, code: 'WRONG_DATE' }).consent).toBe(false);
        expect(new EnableBankingError('x', { status: 500, code: 'SESSION_ERROR' }).consent).toBe(false);
    });
});

describe('pickBalance', () => {
    it('prefers CLBD over ITBD and XPCD', () => {
        expect(pickBalance([
            { balance_type: 'XPCD', balance_amount: { amount: '3', currency: 'EUR' } },
            { balance_type: 'CLBD', balance_amount: { amount: '1', currency: 'EUR' } },
            { balance_type: 'ITBD', balance_amount: { amount: '2', currency: 'EUR' } },
        ])).toEqual({ amount: '1', currency: 'EUR', type: 'CLBD' });
    });

    it('falls back to the first balance and returns null for none', () => {
        expect(pickBalance([{ balance_type: 'OTHR', balance_amount: { amount: '9', currency: 'EUR' } }]))
            .toEqual({ amount: '9', currency: 'EUR', type: 'OTHR' });
        expect(pickBalance([])).toBeNull();
        expect(pickBalance(undefined)).toBeNull();
    });
});

describe('date window (R8)', () => {
    it('first sync: UTC midnight of the connection date minus history days', () => {
        expect(isoDate(syncCutoffDate(new Date('2026-10-11T15:00:00Z'), 1))).toBe('2026-10-10');
        expect(isoDate(syncDateFrom({ createdAt: new Date('2026-10-11T15:00:00Z'), historyDays: 1, lastSync: null }))).toBe('2026-10-10');
    });

    it('handles 0, a large window and a connection just after midnight', () => {
        expect(isoDate(syncCutoffDate(new Date('2026-10-11T15:00:00Z'), 0))).toBe('2026-10-11');
        expect(isoDate(syncCutoffDate(new Date('2026-10-11T15:00:00Z'), 730))).toBe('2024-10-11');
        expect(isoDate(syncCutoffDate(new Date('2026-10-11T00:00:01Z'), 1))).toBe('2026-10-10');
        expect(isoDate(syncCutoffDate(new Date('2026-10-11T15:00:00Z'), -3))).toBe('2026-10-11');
    });

    it('later syncs: max(cutoff, lastSync − 7 days)', () => {
        const createdAt = new Date('2026-10-11T15:00:00Z');
        expect(isoDate(syncDateFrom({ createdAt, historyDays: 1, lastSync: new Date('2026-10-12T06:15:00Z') }))).toBe('2026-10-10');
        expect(isoDate(syncDateFrom({ createdAt, historyDays: 1, lastSync: new Date('2026-11-20T06:15:00Z') }))).toBe('2026-11-13');
    });
});

describe('budget helpers (D5)', () => {
    it('keys the budget by the Europe/Madrid day', () => {
        expect(budgetDay(new Date('2026-10-11T21:59:00Z'))).toBe('2026-10-11');
        expect(budgetDay(new Date('2026-10-11T22:01:00Z'))).toBe('2026-10-12');
        expect(budgetKey('eba1', '2026-10-11')).toBe('ebbudget:v1:eba1:2026-10-11');
    });

    it('resets at Madrid midnight, across both DST offsets', () => {
        expect(budgetResetsAt(new Date('2026-10-11T10:00:00Z')).toISOString()).toBe('2026-10-11T22:00:00.000Z');
        expect(budgetResetsAt(new Date('2026-12-24T10:00:00Z')).toISOString()).toBe('2026-12-24T23:00:00.000Z');
        expect(budgetResetsAt(new Date('2026-10-24T10:00:00Z')).toISOString()).toBe('2026-10-24T22:00:00.000Z');
    });

    it('reads the daily budget and sync slots from the env with safe defaults', () => {
        expect(getDailyBudget({})).toBe(4);
        expect(getDailyBudget({ ENABLE_BANKING_DAILY_BUDGET: '6' })).toBe(6);
        expect(getDailyBudget({ ENABLE_BANKING_DAILY_BUDGET: 'x' })).toBe(4);
        expect(getSyncTimes({})).toEqual(DEFAULT_SYNC_TIMES);
        expect(DEFAULT_SYNC_TIMES).toHaveLength(3);
        expect(getSyncTimes({ ENABLE_BANKING_SYNC_TIMES: '07:00, 25:00,19:30,07:00' })).toEqual(['07:00', '19:30']);
        expect(getSyncTimes({ ENABLE_BANKING_SYNC_TIMES: 'nope' })).toEqual(DEFAULT_SYNC_TIMES);
    });
});

describe('bankTxLabel (D3)', () => {
    it('uses merchantName || name for Plaid and the remittance name for Enable Banking', () => {
        const tx = { name: 'Sq *giro Bar', merchantName: 'Giro Bar' };
        expect(bankTxLabel(tx, 'PLAID')).toBe('Giro Bar');
        expect(bankTxLabel(tx, undefined)).toBe('Giro Bar');
        expect(bankTxLabel(tx, 'ENABLE_BANKING')).toBe('Sq *giro Bar');
        expect(bankTxLabel({ name: '', merchantName: 'X' }, 'ENABLE_BANKING')).toBe('X');
    });
});
