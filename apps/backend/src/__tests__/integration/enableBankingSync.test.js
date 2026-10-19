/**
 * Integration: Enable Banking sync against the real bliss_test database (#132).
 *
 * - Running the same sync twice inserts nothing the second time (R10).
 * - A reconnect (new session, new uids, same identification_hash) inserts nothing.
 * - Per-tenant credentials (#148): a tenant without credentials is paused (no
 *   log, no status change) and resumes with the 7-day overlap once they are
 *   saved; the real client cache signs with the tenant's own app id.
 *
 * The Enable Banking client, the budget counter and the processing queue are
 * mocked; Postgres is real. Requires: bliss_test with migrations applied.
 */

const mockProcessingAdd = jest.fn().mockResolvedValue({});
jest.mock('../../queues/plaidProcessingQueue', () => ({
  getPlaidProcessingQueue: () => ({ add: mockProcessingAdd }),
}));
jest.mock('../../services/enableBanking/budget', () => ({
  consumeAccess: jest.fn().mockResolvedValue({ allowed: true, used: 1, limit: 4 }),
}));
jest.mock('../../utils/redis', () => ({ getRedisConnection: jest.fn(() => ({})) }));

const fs = require('fs');
const path = require('path');
const prisma = require('../../../prisma/prisma');
const { createIsolatedTenant, teardownTenant } = require('../helpers/tenant');
const { ensureReferenceData } = require('../helpers/referenceData');
const {
  __setEnableBankingClientForTests,
  getTenantEnableBanking,
  markCredentialInvalid,
} = require('../../services/enableBanking/client');
const { parsePrivateKey, appIdHash, syncDateFrom, isoDate } = require('@bliss/shared/enablebanking');

const KEY = parsePrivateKey(fs.readFileSync(
  path.join(__dirname, '../../../../../packages/shared/test-fixtures/enablebanking-keys/rsa2048-pkcs8.pem'), 'utf8',
));
const APP_ID = '0b9c1f9e-1d2a-4c55-9c3e-5a1b2c3d4e5f';
const saveCredential = () => prisma.enableBankingCredential.create({
  data: {
    tenantId,
    appId: APP_ID,
    appIdHash: appIdHash(APP_ID),
    privateKey: KEY.pem,
    keyFingerprint: KEY.fingerprint,
    keyBits: KEY.bits,
    status: 'VERIFIED',
  },
});
const { syncConnection } = require('../../workers/handlers/enableBankingSync');

const HASH = `idhash-${Date.now()}`;
let tenantId;
let item;
let ebAccount;
let ref;

const transactions = [
  { entry_reference: 'r1', status: 'BOOK', credit_debit_indicator: 'DBIT', transaction_amount: { amount: '10.70', currency: 'EUR' }, booking_date: '2026-10-10', remittance_information: ['Taxi Lic 1137'], creditor: { name: 'TAXI' } },
  { entry_reference: 'r2', status: 'BOOK', credit_debit_indicator: 'CRDT', transaction_amount: { amount: '50.00', currency: 'EUR' }, booking_date: '2026-10-11', remittance_information: ['Bizum'], debtor: { name: 'Patricia' } },
  { entry_reference: 'r3', status: 'PDNG', credit_debit_indicator: 'DBIT', transaction_amount: { amount: '3.00', currency: 'EUR' }, booking_date: '2026-10-11', remittance_information: ['Pending'] },
];

const fakeClient = {
  getTransactions: jest.fn(async (_uid, { continuationKey }) => (continuationKey
    ? { transactions: transactions.slice(1) }
    : { transactions: transactions.slice(0, 1), continuation_key: 'page-2' })),
  getBalances: jest.fn(async () => [{ balance_type: 'CLBD', balance_amount: { amount: '1000.50', currency: 'EUR' } }]),
};

const job = () => ({ id: 'j', name: 'ENABLE_BANKING_SYNC', data: { plaidItemId: item.id, tenantId } });

beforeAll(async () => {
  ref = await ensureReferenceData({ countryId: 'ESP', currencyCode: 'EUR', bankName: 'Integration Test Bank' });
  ({ tenantId } = await createIsolatedTenant({ suffix: 'eb-sync' }));
  const user = await prisma.user.create({ data: { email: `eb-${Date.now()}@test.local`, tenantId } });
  item = await prisma.plaidItem.create({
    data: {
      tenantId,
      userId: user.id,
      itemId: `eb_${Date.now()}`,
      accessToken: 'session-1',
      provider: 'ENABLE_BANKING',
      institutionName: 'Revolut',
      aspspCountry: 'ES',
      consentExpiration: new Date(Date.now() + 179 * 86400_000),
      createdAt: new Date('2026-10-11T15:00:00Z'),
    },
  });
  const account = await prisma.account.create({
    data: {
      name: 'Revolut Joint',
      accountNumber: 'ES0000004704',
      bankId: ref.bankId,
      countryId: ref.countryId,
      currencyCode: 'EUR',
      tenantId,
      plaidAccountId: `eb:${HASH}`,
      plaidItemId: item.id,
    },
  });
  ebAccount = await prisma.enableBankingAccount.create({
    data: {
      tenantId,
      plaidItemId: item.id,
      authorizedByUserId: user.id,
      uid: 'uid-session-1',
      identificationHash: HASH,
      iban: 'ES0000000000004704',
      ibanLast4: '4704',
      currency: 'EUR',
      accountId: account.id,
    },
  });
  await saveCredential();
  __setEnableBankingClientForTests(fakeClient);
});

afterAll(async () => {
  __setEnableBankingClientForTests(null);
  await teardownTenant(tenantId);
  await prisma.$disconnect();
});

it('first sync pages, ingests booked rows only and stores the balance', async () => {
  const result = await syncConnection(job());
  expect(result).toMatchObject({ status: 'SUCCESS', added: 2, pendingSeen: 1 });
  expect(fakeClient.getTransactions).toHaveBeenNthCalledWith(1, 'uid-session-1', { dateFrom: '2026-10-10', continuationKey: undefined });

  const rows = await prisma.plaidTransaction.findMany({ where: { plaidItemId: item.id }, orderBy: { date: 'asc' } });
  expect(rows.map(r => [r.plaidTransactionId, Number(r.amount), r.name])).toEqual([
    [`eb:${HASH}:r1`, 10.7, 'Taxi Lic 1137'],
    [`eb:${HASH}:r2`, -50, 'Bizum'],
  ]);
  const acc = await prisma.enableBankingAccount.findUnique({ where: { id: ebAccount.id } });
  expect(Number(acc.lastBalance)).toBe(1000.5);
  expect(acc.iban).toBe('ES0000000000004704'); // decrypted transparently

  const logs = await prisma.plaidSyncLog.findMany({ where: { plaidItemId: item.id } });
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({ type: 'INITIAL_SYNC', status: 'SUCCESS' });
  expect(mockProcessingAdd).toHaveBeenCalledTimes(1);
});

it('re-queues classification when a sync adds nothing but rows are still unprocessed', async () => {
  // The classifier is mocked here, so the first sync's rows are still PENDING —
  // exactly the state of rows left behind by an earlier run (e.g. seed holds).
  mockProcessingAdd.mockClear();
  const result = await syncConnection(job());
  expect(result).toMatchObject({ added: 0, skipped: 2 });
  expect(mockProcessingAdd).toHaveBeenCalledTimes(1);
});

it('running the same sync again adds zero rows and enqueues no classification', async () => {
  // As after a real classifier run.
  await prisma.plaidTransaction.updateMany({ where: { plaidItemId: item.id }, data: { processed: true, promotionStatus: 'CLASSIFIED' } });
  mockProcessingAdd.mockClear();
  const result = await syncConnection(job());
  expect(result).toMatchObject({ added: 0, skipped: 2 });
  expect(await prisma.plaidTransaction.count({ where: { plaidItemId: item.id } })).toBe(2);
  expect(mockProcessingAdd).not.toHaveBeenCalled();
});

it('a reconnect (new session id, new uid, same identification_hash) adds zero rows', async () => {
  await prisma.plaidItem.update({ where: { id: item.id }, data: { accessToken: 'session-2' } });
  await prisma.enableBankingAccount.update({ where: { id: ebAccount.id }, data: { uid: 'uid-session-2' } });
  const result = await syncConnection(job());
  expect(fakeClient.getTransactions).toHaveBeenLastCalledWith('uid-session-2', expect.any(Object));
  expect(result.added).toBe(0);
  expect(await prisma.plaidTransaction.count({ where: { plaidItemId: item.id } })).toBe(2);
});

describe('per-tenant credentials (#148)', () => {
  it('paused: without credentials a sync is skipped with no log and no status change', async () => {
    await prisma.enableBankingCredential.deleteMany({ where: { tenantId } });
    const lastSync = new Date('2026-10-25T06:15:00Z'); // overlap (10-18) is after the history cutoff (10-10)
    await prisma.plaidItem.update({ where: { id: item.id }, data: { lastSync } });
    const logsBefore = await prisma.plaidSyncLog.count({ where: { plaidItemId: item.id } });
    fakeClient.getTransactions.mockClear();

    await expect(syncConnection(job())).resolves.toEqual({ skipped: 'paused' });
    expect(await prisma.plaidSyncLog.count({ where: { plaidItemId: item.id } })).toBe(logsBefore);
    expect((await prisma.plaidItem.findUnique({ where: { id: item.id } })).status).toBe('ACTIVE');
    expect(fakeClient.getTransactions).not.toHaveBeenCalled();
  });

  it('resumes once credentials are saved, re-reading from lastSync − 7 days with no duplicates', async () => {
    await saveCredential();
    const { lastSync, createdAt } = await prisma.plaidItem.findUnique({ where: { id: item.id } });
    const result = await syncConnection(job());
    expect(result).toMatchObject({ status: 'SUCCESS', added: 0 });
    expect(fakeClient.getTransactions.mock.calls[0][1].dateFrom).toBe('2026-10-18');
    expect(isoDate(syncDateFrom({ createdAt, historyDays: 1, lastSync }))).toBe('2026-10-18');
    expect(await prisma.plaidTransaction.count({ where: { plaidItemId: item.id } })).toBe(2);
  });

  it('the real resolver signs with the tenant\'s own app and never exposes the key', async () => {
    __setEnableBankingClientForTests(null);
    try {
      const seen = [];
      const realFetch = global.fetch;
      global.fetch = async (_url, init) => {
        seen.push(init.headers.Authorization);
        return { ok: true, status: 200, text: async () => '{}' };
      };
      try {
        const eb = await getTenantEnableBanking(tenantId);
        expect(eb.credential).toEqual(expect.objectContaining({ tenantId, status: 'VERIFIED' }));
        expect(JSON.stringify(eb.credential)).not.toContain('PRIVATE KEY');
        await eb.client.getApplication();
      } finally {
        global.fetch = realFetch;
      }
      const header = JSON.parse(Buffer.from(seen[0].slice(7).split('.')[0], 'base64url').toString());
      expect(header.kid).toBe(APP_ID);
      expect(await getTenantEnableBanking('no-such-tenant')).toBeNull();
    } finally {
      __setEnableBankingClientForTests(fakeClient);
    }
  });

  it('markCredentialInvalid is conditional on the credential version', async () => {
    const { version } = await prisma.enableBankingCredential.findUnique({ where: { tenantId } });
    expect(await markCredentialInvalid(tenantId, version + 1)).toBe(false);
    expect(await markCredentialInvalid(tenantId, version)).toBe(true);
    const row = await prisma.enableBankingCredential.findUnique({ where: { tenantId } });
    expect(row).toMatchObject({ status: 'INVALID', invalidatedAt: expect.any(Date) });
    expect(await markCredentialInvalid(tenantId, version)).toBe(false); // already INVALID
  });
});

// The R6 partial unique index is SQL-only (migration). Backend CI builds its
// database with `prisma db push`, which never creates it, so the DB-level check
// lives in the API flow suite (apps/api, migrate deploy).
