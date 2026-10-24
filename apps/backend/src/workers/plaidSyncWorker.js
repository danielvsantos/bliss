const { Worker } = require('bullmq');
const { plaidClient } = require('../services/plaid');
const prisma = require('../../prisma/prisma');
const { encrypt } = require('../utils/encryption'); // Used for PlaidTransaction.rawJson manual encryption
const { getRedisConnection } = require('../utils/redis');
const { getPlaidProcessingQueue } = require('../queues/plaidProcessingQueue');
const logger = require('../utils/logger');
const { reportWorkerFailure } = require('../utils/workerFailureReporter');
const { trackWorker } = require('../utils/activityTracker');
const { getPlaidSyncQueue } = require('../queues/plaidSyncQueue');
const { enableBankingDispatch, syncConnection } = require('./handlers/enableBankingSync');
const { etoroDispatch } = require('./handlers/etoroSync');
const { syncCutoffDate } = require('../services/enableBanking/dateWindow');
const { getSyncTimes, BUDGET_TIMEZONE } = require('@bliss/shared/enablebanking');

const QUEUE_NAME = 'plaid-sync';
const PAGE_SIZE = 500;

/**
 * Maps a raw Plaid transaction object to the PlaidTransaction Prisma shape.
 * Shared by transactionsSync (added) and transactionsGet (backfill) paths.
 */
function mapPlaidTransaction(plaidItemId, txn) {
    return {
        plaidItemId,
        plaidAccountId: txn.account_id,
        plaidTransactionId: txn.transaction_id,
        amount: txn.amount,
        date: new Date(txn.date),
        authorizedDate: txn.authorized_date ? new Date(txn.authorized_date) : null,
        name: txn.name,
        merchantName: txn.merchant_name,
        paymentChannel: txn.payment_channel,
        isoCurrencyCode: txn.iso_currency_code,
        pending: txn.pending,
        category: txn.personal_finance_category || [],
        pendingTransactionId: txn.pending_transaction_id,
        syncType: 'ADDED',
        processed: false,
        rawJson: encrypt(JSON.stringify(txn)),
    };
}

/**
 * Tracks the earliest transaction date from a batch of Plaid transactions.
 * Returns the new earliest date or the existing one if no earlier date found.
 */
function trackEarliestDate(transactions, currentEarliest) {
    const batchDates = transactions
        .map(tx => tx.date ? new Date(tx.date) : null)
        .filter(d => d !== null && !isNaN(d.getTime()));
    if (batchDates.length > 0) {
        const batchEarliest = new Date(Math.min(...batchDates.map(d => d.getTime())));
        if (!currentEarliest || batchEarliest < currentEarliest) {
            return batchEarliest;
        }
    }
    return currentEarliest;
}

/**
 * Registers one repeatable ENABLE_BANKING_SYNC_ALL job scheduler per
 * ENABLE_BANKING_SYNC_TIMES slot (Europe/Madrid), and removes schedulers for
 * slots no longer configured. Always registered (#148): credentials are per
 * tenant, so whether anything syncs is decided per connection by the fan-out.
 */
async function registerEnableBankingSchedule() {
    const queue = getPlaidSyncQueue();
    const times = getSyncTimes();
    const wanted = new Set(times.map(t => `eb-sync-all-${t.replace(':', '')}`));
    const existing = await queue.getJobSchedulers();
    for (const s of existing) {
        if (s.key?.startsWith('eb-sync-all-') && !wanted.has(s.key)) {
            await queue.removeJobScheduler(s.key);
        }
    }
    for (const time of times) {
        const [hh, mm] = time.split(':').map(Number);
        await queue.upsertJobScheduler(
            `eb-sync-all-${time.replace(':', '')}`,
            { pattern: `${mm} ${hh} * * *`, tz: BUDGET_TIMEZONE },
            { name: 'ENABLE_BANKING_SYNC_ALL', data: {} },
        );
    }
    logger.info(`[plaidSyncWorker] Enable Banking sync scheduled at ${times.join(', ')} (${BUDGET_TIMEZONE})`);
    return times;
}

/** eToro copy sync (#143): nightly at 03:30 UTC, after the security master, before revaluation. */
const ETORO_SYNC_SCHEDULER_KEY = 'etoro-sync-all';
const ETORO_SYNC_PATTERN = '30 3 * * *';

async function registerEtoroSchedule() {
    await getPlaidSyncQueue().upsertJobScheduler(
        ETORO_SYNC_SCHEDULER_KEY,
        { pattern: ETORO_SYNC_PATTERN, tz: 'UTC' },
        { name: 'ETORO_SYNC_ALL', data: {} },
    );
    logger.info(`[plaidSyncWorker] eToro copy sync scheduled at 03:30 UTC`);
}

let worker;

const startPlaidSyncWorker = () => {

    // Ensure Redis connection is available
    const connection = getRedisConnection();

    worker = new Worker(QUEUE_NAME, async (job) => {
        // Enable Banking jobs share this queue (#132, decision D4).
        if (job.name?.startsWith('ENABLE_BANKING_')) {
            return enableBankingDispatch(job);
        }
        // eToro copy trading jobs share it too (#143, decision D8).
        if (job.name?.startsWith('ETORO_')) {
            return etoroDispatch(job);
        }

        logger.info(`Starting job ${job.name} for Plaid Item: ${job.data.plaidItemId}`);

        const { plaidItemId, source } = job.data;
        if (!plaidItemId) {
            throw new Error('plaidItemId is required');
        }

        let totalAdded = 0;
        let totalModified = 0;
        let totalRemoved = 0;
        let overallEarliestDate = null; // Track earliest transaction date across all pages
        const syncType = source === 'HISTORICAL_BACKFILL'
            ? 'HISTORICAL_BACKFILL'
            : (job.name === 'PLAID_INITIAL_SYNC' ? 'INITIAL_SYNC' : 'SYNC_UPDATE');

        try {
            const plaidItem = await prisma.plaidItem.findUnique({
                where: { id: plaidItemId },
                include: { tenant: { select: { plaidHistoryDays: true } } },
            });

            if (!plaidItem) {
                throw new Error(`Plaid Item not found: ${plaidItemId}`);
            }

            // Skip gracefully for non-ACTIVE items (e.g. REVOKED / soft-disconnected).
            // We don't throw here — the job completes cleanly so it won't be retried.
            if (plaidItem.status !== 'ACTIVE') {
                logger.info(`[plaidSyncWorker] Skipping sync for item ${plaidItemId}: status is ${plaidItem.status}`);
                return;
            }

            // A generic Plaid event (resync / post-reconnect PATCH) for an Enable
            // Banking connection must never send its session id to Plaid (#132).
            if (plaidItem.provider === 'ENABLE_BANKING') {
                return syncConnection(job);
            }

            // accessToken is auto-decrypted by Prisma middleware (PlaidItem.accessToken in encryptedFields)
            const accessToken = plaidItem.accessToken;
            let batchCount = 0;

            if (source === 'HISTORICAL_BACKFILL') {
                // ── Historical Backfill via transactions/get ─────────────────────────
                const { fromDate } = job.data;
                const endDate = plaidItem.earliestTransactionDate
                    ? plaidItem.earliestTransactionDate.toISOString().slice(0, 10)
                    : new Date().toISOString().slice(0, 10);

                logger.info(`[plaidSyncWorker] Historical backfill for ${plaidItemId}: ${fromDate} → ${endDate}`);

                let offset = 0;
                let totalTransactions = null;

                while (totalTransactions === null || offset < totalTransactions) {
                    const response = await plaidClient.transactionsGet({
                        access_token: accessToken,
                        start_date: fromDate,
                        end_date: endDate,
                        options: { count: PAGE_SIZE, offset },
                    });

                    const { transactions, total_transactions } = response.data;
                    totalTransactions = total_transactions;

                    if (transactions.length === 0) break;

                    const txData = transactions.map(txn => mapPlaidTransaction(plaidItemId, txn));
                    const result = await prisma.plaidTransaction.createMany({ data: txData, skipDuplicates: true });

                    overallEarliestDate = trackEarliestDate(transactions, overallEarliestDate);

                    offset += transactions.length;
                    totalAdded += result.count;
                    batchCount++;
                    logger.info(
                        `[plaidSyncWorker] Backfill batch ${batchCount}: fetched ${transactions.length}, ` +
                        `inserted ${result.count} (offset=${offset}/${totalTransactions})`
                    );
                }
            } else {
                // ── Incremental Sync via transactions/sync ──────────────────────────
                // Compute a date cutoff anchored to when this PlaidItem was created,
                // using the tenant's plaidHistoryDays setting (editable via Settings page).
                // This matches the days_requested passed to create-link-token and prevents
                // resyncs from pulling history that Plaid has backfilled beyond that window.
                const historyDays = plaidItem.tenant?.plaidHistoryDays ?? 1;
                const cutoffDate = syncCutoffDate(plaidItem.createdAt, historyDays);

                // Only accounts still linked to a Bliss account are ingested: an
                // account switched to Enable Banking (R5a) keeps the Plaid item
                // alive for its siblings, but must not keep feeding duplicates.
                const linkedAccounts = await prisma.account.findMany({
                    where: { tenantId: plaidItem.tenantId, plaidItemId, plaidAccountId: { not: null } },
                    select: { plaidAccountId: true },
                });
                const linkedPlaidAccountIds = new Set(linkedAccounts.map(a => a.plaidAccountId));

                let cursor = plaidItem.nextCursor;
                let hasMore = true;

                while (hasMore) {
                    const response = await plaidClient.transactionsSync({
                        access_token: accessToken,
                        cursor: cursor,
                        count: PAGE_SIZE
                    });

                    const data = response.data;
                    const { added, modified, removed, next_cursor } = data;

                    // 1. Handle Added — filter to cutoff window, then bulk insert.
                    // plaidTransactionId has @unique — skipDuplicates makes retries safe.
                    if (added.length > 0) {
                        const linked = added.filter(txn => linkedPlaidAccountIds.has(txn.account_id));
                        if (linked.length < added.length) {
                            logger.info(
                                `[plaidSyncWorker] Dropped ${added.length - linked.length} transaction(s) for ` +
                                `account(s) no longer linked to item ${plaidItemId}`
                            );
                        }
                        const withinWindow = linked.filter(txn => {
                            const txnDate = txn.date ? new Date(txn.date) : null;
                            return txnDate && txnDate >= cutoffDate;
                        });
                        if (withinWindow.length > 0) {
                            const addedData = withinWindow.map(txn => mapPlaidTransaction(plaidItemId, txn));
                            await prisma.plaidTransaction.createMany({ data: addedData, skipDuplicates: true });
                            overallEarliestDate = trackEarliestDate(withinWindow, overallEarliestDate);
                        }
                        if (withinWindow.length < linked.length) {
                            logger.info(
                                `[plaidSyncWorker] Filtered ${linked.length - withinWindow.length} transaction(s) ` +
                                `before cutoff ${cutoffDate.toISOString().slice(0, 10)} for item ${plaidItemId}`
                            );
                        }
                    }

                    // 2. Handle Modified — small array, sequential upserts
                    for (const txn of modified) {
                        const existing = await prisma.plaidTransaction.findUnique({
                            where: { plaidTransactionId: txn.transaction_id }
                        });

                        if (existing) {
                            await prisma.plaidTransaction.update({
                                where: { id: existing.id },
                                data: {
                                    amount: txn.amount,
                                    date: new Date(txn.date),
                                    name: txn.name,
                                    merchantName: txn.merchant_name,
                                    pending: txn.pending,
                                    category: txn.personal_finance_category || [],
                                    syncType: 'MODIFIED',
                                    processed: false,
                                    rawJson: encrypt(JSON.stringify(txn))
                                }
                            });
                        } else {
                            // Treat as added if we missed it
                            await prisma.plaidTransaction.create({
                                data: mapPlaidTransaction(plaidItemId, txn),
                            });
                        }
                    }

                    // 3. Handle Removed — small array, sequential updates
                    for (const txn of removed) {
                        const existing = await prisma.plaidTransaction.findUnique({
                            where: { plaidTransactionId: txn.transaction_id }
                        });

                        if (existing) {
                            await prisma.plaidTransaction.update({
                                where: { id: existing.id },
                                data: {
                                    syncType: 'REMOVED',
                                    processed: false
                                }
                            });
                        }
                    }

                    // 4. Update Cursor
                    await prisma.plaidItem.update({
                        where: { id: plaidItemId },
                        data: { nextCursor: next_cursor }
                    });

                    cursor = next_cursor;
                    hasMore = data.has_more;
                    batchCount++;
                    totalAdded += added.length;
                    totalModified += modified.length;
                    totalRemoved += removed.length;
                    logger.info(`Processed batch ${batchCount} for Item ${plaidItemId}. Added: ${added.length}, Mod: ${modified.length}, Rem: ${removed.length}`);
                }
            }

            logger.info(`${syncType} complete for Item ${plaidItemId}. Triggering processing.`);

            // Update PlaidItem with lastSync, earliestTransactionDate, and historicalSyncComplete
            const plaidItemUpdateData = { lastSync: new Date() };

            if (overallEarliestDate !== null) {
                const currentItem = await prisma.plaidItem.findUnique({
                    where: { id: plaidItemId },
                    select: { earliestTransactionDate: true },
                });
                const shouldUpdate = !currentItem.earliestTransactionDate ||
                    overallEarliestDate < currentItem.earliestTransactionDate;
                if (shouldUpdate) {
                    plaidItemUpdateData.earliestTransactionDate = overallEarliestDate;
                }
            }

            if (source === 'WEBHOOK_HISTORICAL_UPDATE') {
                plaidItemUpdateData.historicalSyncComplete = true;
                logger.info(`[plaidSyncWorker] Marking historical sync complete for PlaidItem ${plaidItemId}`);
            }

            await prisma.plaidItem.update({
                where: { id: plaidItemId },
                data: plaidItemUpdateData,
            });

            // Write sync log — SUCCESS
            await prisma.plaidSyncLog.create({
                data: {
                    plaidItemId,
                    type: syncType,
                    status: 'SUCCESS',
                    details: { added: totalAdded, modified: totalModified, removed: totalRemoved, batches: batchCount },
                },
            }).catch(err => logger.warn(`Failed to write sync log: ${err.message}`));

            // Handoff to Processor via shared queue (no inline Queue creation)
            // Pass source so the processor can decide whether to run the Quick Seed interview
            // (seedHeld behaviour is only appropriate for INITIAL_SYNC — the user is present)
            const processingQueue = getPlaidProcessingQueue();
            // tenantId lets the processing-status tracker attribute this job (#100).
            await processingQueue.add('PLAID_SYNC_COMPLETE', { plaidItemId, source, tenantId: plaidItem.tenantId });

        } catch (error) {
            // Write sync log — FAILED
            await prisma.plaidSyncLog.create({
                data: {
                    plaidItemId,
                    type: syncType,
                    status: 'FAILED',
                    details: { error: error.message, added: totalAdded, modified: totalModified, removed: totalRemoved },
                },
            }).catch(err => logger.warn(`Failed to write error sync log: ${err.message}`));

            // ── Update PlaidItem status on known Plaid API errors ──────────────
            // When Plaid returns a structured error (e.g. ITEM_LOGIN_REQUIRED),
            // update the local status so the UI can reflect the correct state
            // immediately — without waiting for the next ITEM.ERROR webhook.
            const plaidErrorCode = error.response?.data?.error_code;
            if (plaidErrorCode) {
                // TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION is a transient error —
                // data changed while we were paginating. Plaid's fix: reset cursor and retry.
                // Do NOT set status to ERROR — the item is healthy, this is a race condition.
                if (plaidErrorCode === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') {
                    logger.warn(`[plaidSyncWorker] Pagination mutation for item ${plaidItemId}. Resetting cursor to null and retrying.`);
                    await prisma.plaidItem.update({
                        where: { id: plaidItemId },
                        data: { nextCursor: null },
                    }).catch(err => logger.warn(`Failed to reset cursor: ${err.message}`));
                    // Re-throw WITHOUT setting ERROR status. BullMQ will retry.
                    // On retry, cursor is null → sync restarts from beginning (skipDuplicates handles re-inserts safely).
                    throw error;
                }

                // All other Plaid error codes are genuine item health issues.
                const newStatus = plaidErrorCode === 'ITEM_LOGIN_REQUIRED'
                    ? 'LOGIN_REQUIRED'
                    : 'ERROR';
                await prisma.plaidItem.update({
                    where: { id: plaidItemId },
                    data: { status: newStatus, errorCode: plaidErrorCode, updatedAt: new Date() },
                }).catch(err => logger.warn(`Failed to update PlaidItem status after error: ${err.message}`));
                logger.warn(`[plaidSyncWorker] Item ${plaidItemId} → status: ${newStatus} (${plaidErrorCode})`);
            }

            logger.error(`Error syncing Plaid Item ${plaidItemId}: ${error.message}`);
            throw error;
        }
    }, { connection });

    worker.on('failed', (job, err) => {
        // TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION is a known Plaid race condition —
        // cursor is reset and BullMQ retries automatically. Not a bug, skip entirely.
        if (err.message?.includes('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION')) {
            logger.warn(`Plaid sync race condition (will retry): ${job?.id}`);
            return;
        }
        reportWorkerFailure({
            workerName: 'plaidSyncWorker',
            job,
            error: err,
            extra: { plaidItemId: job?.data?.plaidItemId, etoroConnectionId: job?.data?.connectionId },
        });
    });

    logger.info(`Plaid Sync Worker started on queue: ${QUEUE_NAME}`);

    // Processing status (#100): running / progress / completed / final failure.
    trackWorker(worker, QUEUE_NAME);

    // Enable Banking scheduled polling (#132). Fire-and-forget: a scheduling
    // failure is logged but never stops the Plaid worker from starting.
    registerEnableBankingSchedule().catch(err =>
        logger.error(`[plaidSyncWorker] Failed to register Enable Banking schedule: ${err.message}`)
    );
    registerEtoroSchedule().catch(err =>
        logger.error(`[plaidSyncWorker] Failed to register eToro schedule: ${err.message}`)
    );

    // Return worker reference so index.js can close it before disconnecting Redis
    return worker;
};

module.exports = { startPlaidSyncWorker, registerEnableBankingSchedule, registerEtoroSchedule };
