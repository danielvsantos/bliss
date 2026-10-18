/**
 * @bliss/shared/enablebanking + @bliss/shared/bank-tx-label (#132):
 * JWT signing, key parsing (#148, against the shared test keys), the
 * credential probe, the tenant client cache, typed errors, balances, the R8
 * date window and the D5 budget helpers.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    signJwt,
    parsePrivateKey,
    KeyFormatError,
    appIdHash,
    isValidAppId,
    getBaseUrl,
    retiredEnvVars,
    createTenantClientCache,
    isCredentialError,
    probeApplication,
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

const KEYS_DIR = path.join(__dirname, '../../../../../../packages/shared/test-fixtures/enablebanking-keys');
const readKey = (name) => fs.readFileSync(path.join(KEYS_DIR, name), 'utf8');
const MANIFEST = JSON.parse(readKey('manifest.json'));

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

describe('parsePrivateKey (#148, shared test keys)', () => {
    const accepted = Object.entries(MANIFEST).filter(([, e]) => e.ok);
    const rejected = Object.entries(MANIFEST).filter(([, e]) => !e.ok);

    it.each(accepted)('accepts %s', (file, expected) => {
        const parsed = parsePrivateKey(readKey(file));
        expect(parsed.bits).toBe(expected.bits);
        expect(parsed.pem.startsWith('-----BEGIN PRIVATE KEY-----\n')).toBe(true);
        expect(parsed.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{16}$/);
    });

    it.each(rejected)('rejects %s with its code', (file, expected) => {
        const err = (() => { try { parsePrivateKey(readKey(file)); return null; } catch (e) { return e; } })();
        expect(err).toBeInstanceOf(KeyFormatError);
        expect(err.code).toBe(expected.code);
    });

    it('gives every variant of the same key the same fingerprint and stored form', () => {
        const variants = accepted.filter(([, e]) => e.key === 'k4096').map(([f]) => parsePrivateKey(readKey(f)));
        expect(variants).toHaveLength(4);
        expect(new Set(variants.map((v) => v.fingerprint)).size).toBe(1);
        expect(new Set(variants.map((v) => v.pem)).size).toBe(1);
        expect(parsePrivateKey(readKey('rsa2048-pkcs8.pem')).fingerprint).not.toBe(variants[0].fingerprint);
    });

    it('re-exports a key that signs JWTs verifiable with the original public key', () => {
        const { pem } = parsePrivateKey(PRIVATE_PEM.replace(/\n/g, '\r\n'));
        const [h, c, sig] = signJwt({ appId: 'app', privateKeyPem: pem, now: 1 }).split('.');
        const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url'));
        expect(ok).toBe(true);
    });

    it('rejects empty input and never echoes key material in messages', () => {
        expect(() => parsePrivateKey('')).toThrow(KeyFormatError);
        expect(() => parsePrivateKey(undefined)).toThrow(KeyFormatError);
        const truncated = readKey('truncated.pem');
        const err = (() => { try { parsePrivateKey(truncated); return null; } catch (e) { return e; } })();
        expect(err.message).not.toContain(truncated.split('\n')[1]);
    });
});

describe('app id, env and probe helpers (#148)', () => {
    it('validates UUID app ids and hashes them case-insensitively', () => {
        expect(isValidAppId('9a1b2c3d-1111-2222-3333-444455556666')).toBe(true);
        expect(isValidAppId('not-a-uuid')).toBe(false);
        expect(isValidAppId(undefined)).toBe(false);
        expect(appIdHash('9A1B2C3D-1111-2222-3333-444455556666')).toBe(appIdHash(' 9a1b2c3d-1111-2222-3333-444455556666 '));
        expect(appIdHash('9a1b2c3d-1111-2222-3333-444455556666')).toHaveLength(32);
    });

    it('keeps only the API base URL deployment-wide and lists retired env vars that are set', () => {
        expect(getBaseUrl({})).toBe('https://api.enablebanking.com');
        expect(getBaseUrl({ ENABLE_BANKING_API_URL: ' https://x.test ' })).toBe('https://x.test');
        expect(retiredEnvVars({})).toEqual([]);
        expect(retiredEnvVars({ ENABLE_BANKING_APP_ID: 'a', ENABLE_BANKING_PRIVATE_KEY: ' ', ENABLE_BANKING_PRIVATE_KEY_PATH: '/k' }))
            .toEqual(['ENABLE_BANKING_APP_ID', 'ENABLE_BANKING_PRIVATE_KEY_PATH']);
    });

    it('treats a 401/403 without a session code as a possible credential error', () => {
        expect(isCredentialError(new EnableBankingError('x', { status: 401 }))).toBe(true);
        expect(isCredentialError(new EnableBankingError('x', { status: 403, code: 'UNAUTHORIZED' }))).toBe(true);
        expect(isCredentialError(new EnableBankingError('x', { status: 401, code: 'EXPIRED_SESSION' }))).toBe(false);
        expect(isCredentialError(new EnableBankingError('x', { status: 400 }))).toBe(false);
        expect(isCredentialError(new Error('x'))).toBe(false);
    });

    it('classifies the GET /application probe', async () => {
        const cb = 'https://bliss.test/api/enablebanking/callback';
        const ok = (body) => ({ getApplication: async () => body });
        const fail = (status, code) => ({ getApplication: async () => { throw new EnableBankingError('x', { status, code, retryable: status === 0 || status === 429 || status >= 500 }); } });
        await expect(probeApplication(ok({ redirect_urls: [`${cb}/`] }), { callbackUrl: cb })).resolves.toEqual({ result: 'VERIFIED', callbackRegistered: true });
        await expect(probeApplication(ok({ redirect_urls: ['https://other.test'] }), { callbackUrl: cb })).resolves.toEqual({ result: 'VERIFIED', callbackRegistered: false });
        await expect(probeApplication(ok({}), { callbackUrl: cb })).resolves.toEqual({ result: 'VERIFIED', callbackRegistered: null });
        await expect(probeApplication(ok({ environment: 'SANDBOX' }))).resolves.toMatchObject({ result: 'SANDBOX' });
        for (const status of [401, 403, 404]) {
            await expect(probeApplication(fail(status))).resolves.toMatchObject({ result: 'INVALID', httpStatus: status });
        }
        for (const status of [0, 429, 502]) {
            await expect(probeApplication(fail(status))).resolves.toMatchObject({ result: 'UNREACHABLE' });
        }
        await expect(probeApplication({ getApplication: async () => { throw new TypeError('bug'); } })).rejects.toThrow('bug');
    });
});

describe('createTenantClientCache (#148, D2)', () => {
    const cred = (tenantId, version, appId = 'app') => ({ tenantId, version, appId, privateKey: PRIVATE_PEM });

    it('reuses a client per (tenant, version) and replaces it on a version bump', () => {
        const cache = createTenantClientCache({ max: 10 });
        const a1 = cache.get(cred('t1', 1));
        expect(cache.get(cred('t1', 1))).toBe(a1);
        const a2 = cache.get(cred('t1', 2));
        expect(a2).not.toBe(a1);
        expect(cache.size).toBe(1);
        cache.get(cred('t2', 1));
        expect(cache.size).toBe(2);
    });

    it('is bounded and evicts the least recently used tenant', () => {
        const cache = createTenantClientCache({ max: 2 });
        const t1 = cache.get(cred('t1', 1));
        cache.get(cred('t2', 1));
        cache.get(cred('t1', 1)); // t1 is now most recent
        cache.get(cred('t3', 1));
        expect(cache.size).toBe(2);
        expect(cache.get(cred('t1', 1))).toBe(t1);
    });

    it('signs each tenant with its own app id', async () => {
        const seen = [];
        const fetchImpl = async (url, init) => {
            seen.push(decode(init.headers.Authorization.slice(7).split('.')[0]).kid);
            return { ok: true, status: 200, text: async () => '{}' };
        };
        const cache = createTenantClientCache({ fetchImpl });
        await cache.get(cred('tA', 1, 'app-A')).getApplication();
        await cache.get(cred('tB', 1, 'app-B')).getApplication();
        expect(seen).toEqual(['app-A', 'app-B']);
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
