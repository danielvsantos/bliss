/**
 * Integration: Enable Banking sync against the real bliss_test database (#132).
 *
 * - Running the same sync twice inserts nothing the second time (R10).
 * - A reconnect (new session, new uids, same identification_hash) inserts nothing.
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

const prisma = require('../../../prisma/prisma');
const { createIsolatedTenant, teardownTenant } = require('../helpers/tenant');
const { ensureReferenceData } = require('../helpers/referenceData');
const { __setEnableBankingClientForTests } = require('../../services/enableBanking/client');
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

// The R6 partial unique index is SQL-only (migration). Backend CI builds its
// database with `prisma db push`, which never creates it, so the DB-level check
// lives in the API flow suite (apps/api, migrate deploy).
