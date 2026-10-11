/**
 * Enable Banking sync (#132). Runs on the plaid-sync queue (decision D4):
 *
 *   ENABLE_BANKING_SYNC      { plaidItemId, tenantId, source }  — one connection
 *   ENABLE_BANKING_SYNC_ALL  {}                                 — scheduled fan-out
 *
 * A connection's mapped accounts are paged through `/transactions` from the
 * R8 window, booked rows are written as PlaidTransaction rows with synthetic
 * keys (createMany skipDuplicates = provider-level dedupe, R10), balances are
 * stored for reconciliation (R14), and classification is handed to the
 * existing plaid-processing queue exactly like a Plaid sync.
 *
 * Every run writes exactly one PlaidSyncLog row (R13 / #51: no silent path).
 * See docs/specs/backend/24-enable-banking.md.
 */

const Sentry = require('@sentry/node');
const prisma = require('../../../prisma/prisma');
const logger = require('../../utils/logger');
const { getRedisConnection } = require('../../utils/redis');
const { carryOrigin } = require('../../utils/activityTracker');
const { getPlaidProcessingQueue } = require('../../queues/plaidProcessingQueue');
const { getPlaidSyncQueue, enableBankingSyncOpts } = require('../../queues/plaidSyncQueue');
const { getEnableBankingClient } = require('../../services/enableBanking/client');
const { mapEnableBankingTransaction, transactionKey } = require('../../services/enableBanking/mapper');
const { syncCutoffDate, syncDateFrom, isoDate } = require('../../services/enableBanking/dateWindow');
const { consumeAccess } = require('../../services/enableBanking/budget');
const { pickBalance, EnableBankingError } = require('@bliss/shared/enablebanking');

const QUEUE_NAME = 'plaid-sync';
const PROVIDER = 'ENABLE_BANKING';
const MAX_PAGES_PER_ACCOUNT = 500; // runaway guard on continuation_key loops

async function writeLog(plaidItemId, type, status, details) {
    // Never swallowed: a sync that cannot record its outcome fails loudly.
    return prisma.plaidSyncLog.create({ data: { plaidItemId, type, status, details } });
}

async function syncAccount(client, item, ebAccount, window, totals) {
    const result = { ebAccountId: ebAccount.id, fetched: 0, added: 0, skipped: 0, pendingSeen: 0, invalid: 0, balance: null };
    let continuationKey;
    let pages = 0;
    const seen = new Set(); // continuation keys already followed (loop guard)

    do {
        const page = await client.getTransactions(ebAccount.uid, {
            dateFrom: window.dateFromIso,
            continuationKey,
        });
        pages++;
        const transactions = Array.isArray(page?.transactions) ? page.transactions : [];
        const rows = [];
        for (const tx of transactions) {
            // Booked only in v1 (R9): pending items are counted, never stored.
            if (tx?.status !== 'BOOK') {
                result.pendingSeen++;
                continue;
            }
            const row = mapEnableBankingTransaction(item.id, ebAccount.identificationHash, tx);
            if (!row) {
                // Booked but without a usable date or amount — counted so it is visible.
                result.invalid++;
                continue;
            }
            if (row.date < window.cutoff) continue; // never before the history window
            if (transactionKey(ebAccount.identificationHash, tx).fallback) {
                logger.warn(`[enableBankingSync] transaction without entry_reference on ${ebAccount.id}; using fingerprint key`);
                totals.fingerprintKeys++;
            }
            rows.push(row);
        }
        if (rows.length > 0) {
            const inserted = await prisma.plaidTransaction.createMany({ data: rows, skipDuplicates: true });
            result.added += inserted.count;
            result.skipped += rows.length - inserted.count;
        }
        result.fetched += rows.length;

        const next = page?.continuation_key || null;
        if (next && seen.has(next)) break;
        if (next) seen.add(next);
        continuationKey = next || undefined;
    } while (continuationKey && pages < MAX_PAGES_PER_ACCOUNT);

    const balance = pickBalance(await client.getBalances(ebAccount.uid));
    if (balance) {
        await prisma.enableBankingAccount.update({
            where: { id: ebAccount.id },
            data: {
                lastBalance: balance.amount,
                lastBalanceCurrency: balance.currency,
                lastBalanceAt: new Date(),
            },
        });
        result.balance = balance;
    }
    result.pages = pages;
    return result;
}

/**
 * Maps a provider error to the connection status it implies, or null when the
 * connection itself is healthy (rate limit, transient error).
 */
function statusForError(err) {
    if (!(err instanceof EnableBankingError) || err.rateLimited) return null;
    if (err.consent) {
        return err.code && /EXPIRED|REVOKED|SESSION|CONSENT/i.test(err.code) ? 'LOGIN_REQUIRED' : 'ERROR';
    }
    return null;
}

async function syncConnection(job) {
    const { plaidItemId, source } = job.data || {};
    if (!plaidItemId) throw new Error('plaidItemId is required');

    const item = await prisma.plaidItem.findUnique({
        where: { id: plaidItemId },
        include: {
            tenant: { select: { plaidHistoryDays: true } },
            enableBankingAccounts: {
                where: { accountId: { not: null } },
                include: { account: { select: { id: true, plaidItemId: true } } },
            },
        },
    });

    if (!item || item.provider !== PROVIDER) {
        logger.warn(`[enableBankingSync] ${plaidItemId} is not an Enable Banking connection — skipping`);
        return { skipped: 'not_enable_banking' };
    }
    if (item.status !== 'ACTIVE') {
        logger.info(`[enableBankingSync] Skipping ${plaidItemId}: status is ${item.status}`);
        return { skipped: 'inactive' };
    }

    const syncType = item.lastSync ? 'SYNC_UPDATE' : 'INITIAL_SYNC';
    const now = new Date();

    if (item.consentExpiration && item.consentExpiration <= now) {
        await prisma.plaidItem.update({
            where: { id: item.id },
            data: { status: 'LOGIN_REQUIRED', errorCode: 'CONSENT_EXPIRED' },
        });
        await writeLog(item.id, syncType, 'FAILED', { error: 'CONSENT_EXPIRED', consentExpiration: item.consentExpiration });
        return { status: 'LOGIN_REQUIRED' };
    }

    const client = getEnableBankingClient();
    if (!client) {
        await writeLog(item.id, syncType, 'FAILED', { error: 'NOT_CONFIGURED' });
        return { skipped: 'not_configured' };
    }

    // Only accounts still linked to this connection are synced (a disconnect
    // or a provider switch away keeps accountId but unlinks the Account row).
    const mapped = item.enableBankingAccounts.filter((a) => a.account?.plaidItemId === item.id);
    const cutoff = syncCutoffDate(item.createdAt, item.tenant?.plaidHistoryDays ?? 1);
    const dateFrom = syncDateFrom({ createdAt: item.createdAt, historyDays: item.tenant?.plaidHistoryDays ?? 1, lastSync: item.lastSync });
    const window = { cutoff, dateFromIso: isoDate(dateFrom) };

    const totals = { fetched: 0, added: 0, skipped: 0, pendingSeen: 0, invalid: 0, fingerprintKeys: 0 };
    const perAccount = [];
    const redis = getRedisConnection();
    let budgetSkips = 0;

    try {
        for (const ebAccount of mapped) {
            const budget = await consumeAccess(redis, ebAccount.id, now);
            if (!budget.allowed) {
                budgetSkips++;
                perAccount.push({ ebAccountId: ebAccount.id, budgetExhausted: true, used: budget.used, limit: budget.limit });
                continue;
            }
            const r = await syncAccount(client, item, ebAccount, window, totals);
            totals.fetched += r.fetched;
            totals.added += r.added;
            totals.skipped += r.skipped;
            totals.pendingSeen += r.pendingSeen;
            totals.invalid += r.invalid;
            perAccount.push(r);
        }
    } catch (err) {
        const details = {
            error: err.message,
            code: err.code || null,
            httpStatus: err.status ?? null,
            ...totals,
            dateFrom: window.dateFromIso,
            perAccount,
            ...(err.rateLimited && { rateLimited: true }),
        };
        await writeLog(item.id, syncType, 'FAILED', details);

        // Rows already inserted are safe (synthetic keys) — hand them to the classifier.
        if (totals.added > 0) await enqueueProcessing(job, item, syncType, null);

        if (err.rateLimited) {
            // Back off to the next scheduled slot: no retry, no Sentry (R13).
            logger.warn(`[enableBankingSync] 429 for ${item.id}; waiting for the next slot`);
            return { status: 'RATE_LIMITED' };
        }
        const newStatus = statusForError(err);
        if (newStatus) {
            await prisma.plaidItem.update({
                where: { id: item.id },
                data: { status: newStatus, errorCode: err.code || `HTTP_${err.status}` },
            });
            Sentry.captureException(err, { extra: { plaidItemId: item.id, tenantId: item.tenantId, status: err.status } });
            logger.warn(`[enableBankingSync] ${item.id} → ${newStatus} (${err.code || err.status})`);
            return { status: newStatus };
        }
        // 5xx / network / unexpected: retried by BullMQ; the final attempt reports via reportWorkerFailure.
        throw err;
    }

    const allBudgetSkipped = mapped.length > 0 && budgetSkips === mapped.length;
    const details = {
        ...totals,
        dateFrom: window.dateFromIso,
        accounts: mapped.length,
        perAccount,
        ...(budgetSkips > 0 && { budgetExhausted: budgetSkips }),
        ...(allBudgetSkipped && { error: 'SYNC_BUDGET_EXHAUSTED' }),
        reason: source || null,
    };
    const log = await writeLog(item.id, syncType, allBudgetSkipped ? 'FAILED' : 'SUCCESS', details);

    if (budgetSkips === 0) {
        await prisma.plaidItem.update({ where: { id: item.id }, data: { lastSync: now, errorCode: null } });
    }
    if (totals.added > 0) await enqueueProcessing(job, item, syncType, log.id);

    logger.info(
        `[enableBankingSync] ${syncType} for ${item.id}: fetched ${totals.fetched}, added ${totals.added}, ` +
        `skipped ${totals.skipped}, pending ${totals.pendingSeen}, from ${window.dateFromIso}`,
    );
    return { status: 'SUCCESS', ...totals };
}

async function enqueueProcessing(job, item, syncType, syncLogId) {
    await getPlaidProcessingQueue().add('PLAID_SYNC_COMPLETE', {
        plaidItemId: item.id,
        tenantId: item.tenantId,
        source: syncType,
        ...(syncLogId && { syncLogId }),
        ...carryOrigin(QUEUE_NAME, job),
    });
}

/** Scheduled fan-out: expire lapsed consents, then one deduplicated sync per active connection. */
async function syncAll() {
    const now = new Date();
    const expired = await prisma.plaidItem.findMany({
        where: { provider: PROVIDER, status: 'ACTIVE', consentExpiration: { lte: now } },
        select: { id: true },
    });
    for (const { id } of expired) {
        await prisma.plaidItem.update({ where: { id }, data: { status: 'LOGIN_REQUIRED', errorCode: 'CONSENT_EXPIRED' } });
        await writeLog(id, 'SYNC_UPDATE', 'FAILED', { error: 'CONSENT_EXPIRED' });
    }

    const active = await prisma.plaidItem.findMany({
        where: { provider: PROVIDER, status: 'ACTIVE' },
        select: { id: true, tenantId: true },
    });
    const queue = getPlaidSyncQueue();
    for (const item of active) {
        await queue.add(
            'ENABLE_BANKING_SYNC',
            { plaidItemId: item.id, tenantId: item.tenantId, source: 'SCHEDULED', _trigger: 'bank_sync' },
            enableBankingSyncOpts(item.id),
        );
    }
    logger.info(`[enableBankingSync] Scheduled ${active.length} sync(s); ${expired.length} consent(s) expired`);
    return { scheduled: active.length, expired: expired.length };
}

async function enableBankingDispatch(job) {
    switch (job.name) {
        case 'ENABLE_BANKING_SYNC':
            return syncConnection(job);
        case 'ENABLE_BANKING_SYNC_ALL':
            return syncAll();
        default:
            throw new Error(`Unknown Enable Banking job: ${job.name}`);
    }
}

module.exports = { enableBankingDispatch, syncConnection, syncAll, statusForError };
