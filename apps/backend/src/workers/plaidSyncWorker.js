const Sentry = require('@sentry/node');
const { Worker } = require('bullmq');
const { plaidClient } = require('../services/plaid');
const prisma = require('../../prisma/prisma');
const { encrypt } = require('../utils/encryption'); // Used for PlaidTransaction.rawJson manual encryption
const { getRedisConnection } = require('../utils/redis');
const { getPlaidProcessingQueue } = require('../queues/plaidProcessingQueue');
const logger = require('../utils/logger');
const { reportWorkerFailure } = require('../utils/workerFailureReporter');

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

let worker;

const startPlaidSyncWorker = () => {

    // Ensure Redis connection is available
    const connection = getRedisConnection();

    worker = new Worker(QUEUE_NAME, async (job) => {
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
                const createdAtMidnight = new Date(plaidItem.createdAt);
                createdAtMidnight.setUTCHours(0, 0, 0, 0);
                const syncCutoffDate = new Date(createdAtMidnight);
                syncCutoffDate.setUTCDate(syncCutoffDate.getUTCDate() - historyDays);

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
                        const withinWindow = added.filter(txn => {
                            const txnDate = txn.date ? new Date(txn.date) : null;
                            return txnDate && txnDate >= syncCutoffDate;
                        });
                        if (withinWindow.length > 0) {
                            const addedData = withinWindow.map(txn => mapPlaidTransaction(plaidItemId, txn));
                            await prisma.plaidTransaction.createMany({ data: addedData, skipDuplicates: true });
                            overallEarliestDate = trackEarliestDate(withinWindow, overallEarliestDate);
                        }
                        if (withinWindow.length < added.length) {
                            logger.info(
                                `[plaidSyncWorker] Filtered ${added.length - withinWindow.length} transaction(s) ` +
                                `before cutoff ${syncCutoffDate.toISOString().slice(0, 10)} for item ${plaidItemId}`
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
            await processingQueue.add('PLAID_SYNC_COMPLETE', { plaidItemId, source });

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
            extra: { plaidItemId: job?.data?.plaidItemId },
        });
    });

    logger.info(`Plaid Sync Worker started on queue: ${QUEUE_NAME}`);

    // Return worker reference so index.js can close it before disconnecting Redis
    return worker;
};

module.exports = { startPlaidSyncWorker };
