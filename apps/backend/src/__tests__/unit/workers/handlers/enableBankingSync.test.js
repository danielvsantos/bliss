/**
 * Enable Banking sync handler (#132): window, paging, pending exclusion,
 * provider dedupe counts, budget, failure matrix (one log row on every path),
 * consent expiry and the scheduled fan-out.
 */

jest.mock('../../../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../../../utils/redis', () => ({ getRedisConnection: jest.fn(() => ({})) }));
jest.mock('../../../../utils/encryption', () => ({ encrypt: jest.fn((v) => `enc:${v}`) }));
jest.mock('../../../../utils/activityTracker', () => ({ carryOrigin: jest.fn(() => ({ _trigger: 'bank_sync' })) }));
jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

const mockProcessingAdd = jest.fn();
jest.mock('../../../../queues/plaidProcessingQueue', () => ({
    getPlaidProcessingQueue: () => ({ add: mockProcessingAdd }),
}));
const mockSyncAdd = jest.fn();
jest.mock('../../../../queues/plaidSyncQueue', () => ({
    getPlaidSyncQueue: () => ({ add: mockSyncAdd }),
    enableBankingSyncOpts: (id) => ({ deduplication: { id: `eb-sync:${id}` }, attempts: 3 }),
}));

const mockClient = { getTransactions: jest.fn(), getBalances: jest.fn() };
let mockClientEnabled = true;
jest.mock('../../../../services/enableBanking/client', () => ({
    getEnableBankingClient: () => (mockClientEnabled ? mockClient : null),
}));

const mockConsumeAccess = jest.fn();
jest.mock('../../../../services/enableBanking/budget', () => ({
    consumeAccess: (...a) => mockConsumeAccess(...a),
}));

const mockPrisma = {
    plaidItem: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    plaidTransaction: { createMany: jest.fn(), count: jest.fn() },
    plaidSyncLog: { create: jest.fn() },
    enableBankingAccount: { update: jest.fn() },
};
jest.mock('../../../../../prisma/prisma', () => mockPrisma);

const Sentry = require('@sentry/node');
const { EnableBankingError } = require('@bliss/shared/enablebanking');
const { syncConnection, syncAll, enableBankingDispatch } = require('../../../../workers/handlers/enableBankingSync');

const ITEM_ID = 'item-eb';
function account(id, hash) {
    return { id, uid: `uid-${id}`, identificationHash: hash, accountId: 1, account: { id: 1, plaidItemId: ITEM_ID, plaidAccountId: `eb:${hash}` } };
}
function item(overrides = {}) {
    return {
        id: ITEM_ID,
        tenantId: 't1',
        provider: 'ENABLE_BANKING',
        status: 'ACTIVE',
        createdAt: new Date('2026-10-11T15:00:00Z'),
        lastSync: null,
        consentExpiration: new Date('2099-01-01'),
        tenant: { plaidHistoryDays: 1 },
        enableBankingAccounts: [account('eba1', 'h1')],
        ...overrides,
    };
}
function ebTx(ref, overrides = {}) {
    return {
        entry_reference: ref,
        status: 'BOOK',
        credit_debit_indicator: 'DBIT',
        transaction_amount: { amount: '10.70', currency: 'EUR' },
        booking_date: '2026-10-10',
        remittance_information: [`Shop ${ref}`],
        creditor: { name: `SHOP ${ref}` },
        ...overrides,
    };
}
const job = (data = {}) => ({ id: 'j1', name: 'ENABLE_BANKING_SYNC', data: { plaidItemId: ITEM_ID, tenantId: 't1', ...data } });
const logs = () => mockPrisma.plaidSyncLog.create.mock.calls.map(c => c[0].data);

beforeEach(() => {
    jest.clearAllMocks();
    mockClientEnabled = true;
    mockPrisma.plaidItem.findUnique.mockResolvedValue(item());
    mockPrisma.plaidItem.update.mockResolvedValue({});
    mockPrisma.plaidSyncLog.create.mockResolvedValue({ id: 'log-1' });
    mockPrisma.plaidTransaction.createMany.mockImplementation(async ({ data }) => ({ count: data.length }));
    mockPrisma.plaidTransaction.count.mockResolvedValue(0);
    mockPrisma.enableBankingAccount.update.mockResolvedValue({});
    mockConsumeAccess.mockResolvedValue({ allowed: true, used: 1, limit: 4 });
    mockClient.getTransactions.mockResolvedValue({ transactions: [ebTx('r1')] });
    mockClient.getBalances.mockResolvedValue([{ balance_type: 'CLBD', balance_amount: { amount: '123.45', currency: 'EUR' } }]);
});

describe('syncConnection — window and mapping', () => {
    it('first sync requests date_from = connection date − history days and drops older rows', async () => {
        mockClient.getTransactions.mockResolvedValue({
            transactions: [ebTx('in'), ebTx('old', { booking_date: '2026-10-09' })],
        });
        const result = await syncConnection(job());
        expect(mockClient.getTransactions).toHaveBeenCalledWith('uid-eba1', { dateFrom: '2026-10-10', continuationKey: undefined });
        const rows = mockPrisma.plaidTransaction.createMany.mock.calls[0][0].data;
        expect(rows.map(r => r.plaidTransactionId)).toEqual(['eb:h1:in']);
        expect(result).toMatchObject({ status: 'SUCCESS', added: 1 });
        expect(logs()).toEqual([expect.objectContaining({ type: 'INITIAL_SYNC', status: 'SUCCESS' })]);
        expect(logs()[0].details).toMatchObject({ dateFrom: '2026-10-10', added: 1, skipped: 0 });
    });

    it('later syncs use max(cutoff, lastSync − 7 days) and log SYNC_UPDATE', async () => {
        mockPrisma.plaidItem.findUnique.mockResolvedValue(item({ lastSync: new Date('2026-11-20T06:15:00Z') }));
        await syncConnection(job());
        expect(mockClient.getTransactions.mock.calls[0][1].dateFrom).toBe('2026-11-13');
        expect(logs()[0].type).toBe('SYNC_UPDATE');
    });

    it('follows continuation_key across pages and stops when it is absent', async () => {
        mockClient.getTransactions
            .mockResolvedValueOnce({ transactions: [ebTx('p1')], continuation_key: 'k1' })
            .mockResolvedValueOnce({ transactions: [ebTx('p2')], continuation_key: 'k2' })
            .mockResolvedValueOnce({ transactions: [ebTx('p3')] });
        const result = await syncConnection(job());
        expect(mockClient.getTransactions).toHaveBeenCalledTimes(3);
        expect(mockClient.getTransactions.mock.calls[1][1].continuationKey).toBe('k1');
        expect(mockClient.getTransactions.mock.calls[2][1].continuationKey).toBe('k2');
        expect(mockPrisma.plaidTransaction.createMany).toHaveBeenCalledTimes(3);
        expect(result.added).toBe(3);
    });

    it('stops on a repeated continuation_key instead of looping', async () => {
        mockClient.getTransactions.mockResolvedValue({ transactions: [], continuation_key: 'same' });
        await syncConnection(job());
        expect(mockClient.getTransactions).toHaveBeenCalledTimes(2);
    });

    it('never stores pending items; the same purchase is added once it is booked', async () => {
        mockClient.getTransactions.mockResolvedValueOnce({ transactions: [ebTx('x', { status: 'PDNG' })] });
        const first = await syncConnection(job());
        expect(mockPrisma.plaidTransaction.createMany).not.toHaveBeenCalled();
        expect(first).toMatchObject({ added: 0, pendingSeen: 1 });
        expect(mockProcessingAdd).not.toHaveBeenCalled();

        mockClient.getTransactions.mockResolvedValueOnce({ transactions: [ebTx('x')] });
        const second = await syncConnection(job());
        expect(second.added).toBe(1);
    });

    it('counts already-ingested entry_references as skipped and enqueues nothing (idempotency)', async () => {
        mockPrisma.plaidTransaction.createMany.mockResolvedValue({ count: 0 });
        const result = await syncConnection(job());
        expect(result).toMatchObject({ added: 0, skipped: 1 });
        expect(mockProcessingAdd).not.toHaveBeenCalled();
        expect(logs()[0].details).toMatchObject({ added: 0, skipped: 1 });
    });

    it('re-queues classification when nothing is new but rows are still unprocessed (stuck seed holds)', async () => {
        mockPrisma.plaidTransaction.createMany.mockResolvedValue({ count: 0 });
        mockPrisma.plaidTransaction.count.mockResolvedValue(5);
        await syncConnection(job());
        expect(mockPrisma.plaidTransaction.count).toHaveBeenCalledWith({
            where: { plaidItemId: ITEM_ID, processed: false, promotionStatus: 'PENDING' },
        });
        expect(mockProcessingAdd).toHaveBeenCalledWith('PLAID_SYNC_COMPLETE', expect.objectContaining({ plaidItemId: ITEM_ID, syncLogId: 'log-1' }));
    });

    it('hands new rows to the classifier with the sync log id and bank_sync trigger', async () => {
        await syncConnection(job());
        expect(mockProcessingAdd).toHaveBeenCalledWith('PLAID_SYNC_COMPLETE', {
            plaidItemId: ITEM_ID, tenantId: 't1', source: 'INITIAL_SYNC', syncLogId: 'log-1', _trigger: 'bank_sync',
        });
    });

    it('stores the closest-to-booked balance and advances lastSync', async () => {
        await syncConnection(job());
        expect(mockPrisma.enableBankingAccount.update).toHaveBeenCalledWith({
            where: { id: 'eba1' },
            data: expect.objectContaining({ lastBalance: '123.45', lastBalanceCurrency: 'EUR' }),
        });
        expect(mockPrisma.plaidItem.update).toHaveBeenCalledWith({
            where: { id: ITEM_ID }, data: expect.objectContaining({ lastSync: expect.any(Date) }),
        });
    });

    it('skips accounts no longer linked to this connection', async () => {
        mockPrisma.plaidItem.findUnique.mockResolvedValue(item({
            enableBankingAccounts: [{ ...account('eba1', 'h1'), account: { id: 1, plaidItemId: null, plaidAccountId: null } }],
        }));
        await syncConnection(job());
        expect(mockClient.getTransactions).not.toHaveBeenCalled();
        expect(logs()).toHaveLength(1);
    });
});

describe('syncConnection — guards', () => {
    it('skips non-Enable-Banking and inactive items without calling the bank', async () => {
        mockPrisma.plaidItem.findUnique.mockResolvedValueOnce(item({ provider: 'PLAID' }));
        expect(await syncConnection(job())).toEqual({ skipped: 'not_enable_banking' });
        mockPrisma.plaidItem.findUnique.mockResolvedValueOnce(item({ status: 'REVOKED' }));
        expect(await syncConnection(job())).toEqual({ skipped: 'inactive' });
        expect(mockClient.getTransactions).not.toHaveBeenCalled();
    });

    it('marks an expired consent LOGIN_REQUIRED and logs it', async () => {
        mockPrisma.plaidItem.findUnique.mockResolvedValue(item({ consentExpiration: new Date('2020-01-01') }));
        expect(await syncConnection(job())).toEqual({ status: 'LOGIN_REQUIRED' });
        expect(mockPrisma.plaidItem.update).toHaveBeenCalledWith({
            where: { id: ITEM_ID }, data: { status: 'LOGIN_REQUIRED', errorCode: 'CONSENT_EXPIRED' },
        });
        expect(logs()).toEqual([expect.objectContaining({ status: 'FAILED', details: expect.objectContaining({ error: 'CONSENT_EXPIRED' }) })]);
        expect(mockClient.getTransactions).not.toHaveBeenCalled();
    });

    it('skips an account over its daily budget and does not advance lastSync', async () => {
        mockPrisma.plaidItem.findUnique.mockResolvedValue(item({ enableBankingAccounts: [account('eba1', 'h1'), account('eba2', 'h2')] }));
        mockConsumeAccess
            .mockResolvedValueOnce({ allowed: true, used: 1, limit: 4 })
            .mockResolvedValueOnce({ allowed: false, used: 5, limit: 4 });
        await syncConnection(job());
        expect(mockClient.getTransactions).toHaveBeenCalledTimes(1);
        expect(logs()[0]).toMatchObject({ status: 'SUCCESS', details: expect.objectContaining({ budgetExhausted: 1 }) });
        expect(mockPrisma.plaidItem.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastSync: expect.any(Date) }) }));
    });

    it('logs FAILED SYNC_BUDGET_EXHAUSTED when every account is over budget', async () => {
        mockConsumeAccess.mockResolvedValue({ allowed: false, used: 5, limit: 4 });
        await syncConnection(job());
        expect(mockClient.getTransactions).not.toHaveBeenCalled();
        expect(logs()[0]).toMatchObject({ status: 'FAILED', details: expect.objectContaining({ error: 'SYNC_BUDGET_EXHAUSTED' }) });
    });
});

describe('syncConnection — failure matrix (one log row each)', () => {
    it('429: FAILED log with rateLimited, no Sentry, no throw, status unchanged', async () => {
        mockClient.getTransactions.mockRejectedValue(new EnableBankingError('429', { status: 429, retryable: true }));
        await expect(syncConnection(job())).resolves.toEqual({ status: 'RATE_LIMITED' });
        expect(logs()).toEqual([expect.objectContaining({ status: 'FAILED', details: expect.objectContaining({ rateLimited: true }) })]);
        expect(Sentry.captureException).not.toHaveBeenCalled();
        expect(mockPrisma.plaidItem.update).not.toHaveBeenCalled();
    });

    it('401 expired session: LOGIN_REQUIRED, Sentry, no throw', async () => {
        mockClient.getTransactions.mockRejectedValue(new EnableBankingError('401', { status: 401, code: 'EXPIRED_SESSION' }));
        await expect(syncConnection(job())).resolves.toEqual({ status: 'LOGIN_REQUIRED' });
        expect(mockPrisma.plaidItem.update).toHaveBeenCalledWith({
            where: { id: ITEM_ID }, data: { status: 'LOGIN_REQUIRED', errorCode: 'EXPIRED_SESSION' },
        });
        expect(Sentry.captureException).toHaveBeenCalledTimes(1);
        expect(logs()).toHaveLength(1);
    });

    it('403 without a session code: ERROR', async () => {
        mockClient.getTransactions.mockRejectedValue(new EnableBankingError('403', { status: 403 }));
        await expect(syncConnection(job())).resolves.toEqual({ status: 'ERROR' });
        expect(mockPrisma.plaidItem.update).toHaveBeenCalledWith({
            where: { id: ITEM_ID }, data: { status: 'ERROR', errorCode: 'HTTP_403' },
        });
        expect(logs()).toHaveLength(1);
    });

    it('5xx: FAILED log and throws so BullMQ retries; rows already inserted are still classified', async () => {
        mockPrisma.plaidItem.findUnique.mockResolvedValue(item({ enableBankingAccounts: [account('eba1', 'h1'), account('eba2', 'h2')] }));
        mockClient.getTransactions
            .mockResolvedValueOnce({ transactions: [ebTx('ok')] })
            .mockRejectedValueOnce(new EnableBankingError('503', { status: 503, retryable: true }));
        await expect(syncConnection(job())).rejects.toThrow('503');
        expect(logs()).toEqual([expect.objectContaining({ status: 'FAILED', details: expect.objectContaining({ httpStatus: 503, added: 1 }) })]);
        expect(mockProcessingAdd).toHaveBeenCalledTimes(1);
        expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('writes no FAILED-silently path: an unexpected error still logs then throws', async () => {
        mockPrisma.plaidTransaction.createMany.mockRejectedValue(new Error('db down'));
        await expect(syncConnection(job())).rejects.toThrow('db down');
        expect(logs()).toEqual([expect.objectContaining({ status: 'FAILED' })]);
    });

    it('logs NOT_CONFIGURED when the client is unavailable', async () => {
        mockClientEnabled = false;
        await syncConnection(job());
        expect(logs()).toEqual([expect.objectContaining({ status: 'FAILED', details: { error: 'NOT_CONFIGURED' } })]);
    });
});

describe('syncAll (scheduled fan-out)', () => {
    it('expires lapsed consents, then enqueues one deduplicated sync per active connection', async () => {
        mockPrisma.plaidItem.findMany
            .mockResolvedValueOnce([{ id: 'expired-1' }])
            .mockResolvedValueOnce([{ id: 'a1', tenantId: 't1' }, { id: 'a2', tenantId: 't2' }]);
        const result = await syncAll();
        expect(result).toEqual({ scheduled: 2, expired: 1 });
        expect(mockPrisma.plaidItem.update).toHaveBeenCalledWith({
            where: { id: 'expired-1' }, data: { status: 'LOGIN_REQUIRED', errorCode: 'CONSENT_EXPIRED' },
        });
        expect(mockSyncAdd).toHaveBeenCalledWith(
            'ENABLE_BANKING_SYNC',
            { plaidItemId: 'a1', tenantId: 't1', source: 'SCHEDULED', _trigger: 'bank_sync' },
            expect.objectContaining({ deduplication: { id: 'eb-sync:a1' } }),
        );
        expect(mockSyncAdd).toHaveBeenCalledTimes(2);
    });

    it('dispatches by job name and rejects unknown names', async () => {
        mockPrisma.plaidItem.findMany.mockResolvedValue([]);
        await expect(enableBankingDispatch({ name: 'ENABLE_BANKING_SYNC_ALL', data: {} })).resolves.toEqual({ scheduled: 0, expired: 0 });
        await expect(enableBankingDispatch({ name: 'ENABLE_BANKING_NOPE', data: {} })).rejects.toThrow(/Unknown/);
    });
});
