const Sentry = require('@sentry/node');
const prisma = require('../../prisma/prisma');
const logger = require('../utils/logger');
const { computeTransactionHash } = require('../utils/transactionHash');
const { resolveTagsByName } = require('../utils/tagUtils');
const categorizationService = require('../services/categorizationService');
const { addDescriptionEntry } = require('../utils/descriptionCache');
const { enqueueEvent } = require('../queues/eventsQueue');

const COMMIT_BATCH_SIZE = 200;

/**
 * Process a smart-import commit job.
 * Promotes CONFIRMED StagedImportRows to Transaction records in batches,
 * links tags, triggers embedding feedback, and produces downstream events.
 *
 * Rows are fetched COMMIT_BATCH_SIZE at a time so memory stays bounded
 * regardless of import size. Marking each batch SKIPPED before fetching
 * the next naturally advances the cursor without skip/offset arithmetic.
 *
 * Updates StagedImport.progress (0-100) incrementally for frontend polling.
 *
 * @param {import('bullmq').Job} job
 */
const processCommitJob = async (job) => {
    const { tenantId, userId, stagedImportId, rowIds } = job.data;

    logger.info(`[CommitWorker] Starting commit for staged import ${stagedImportId}, tenant ${tenantId}`);

    try {
        // ─── 1. Verify import exists and status is COMMITTING ────────────────
        const stagedImport = await prisma.stagedImport.findFirst({
            where: { id: stagedImportId, tenantId },
        });

        if (!stagedImport) {
            throw new Error(`StagedImport ${stagedImportId} not found`);
        }
        if (stagedImport.status !== 'COMMITTING') {
            throw new Error(`StagedImport status is "${stagedImport.status}", expected "COMMITTING"`);
        }

        // ─── 2. Reset progress for commit phase ─────────────────────────────
        await prisma.stagedImport.update({
            where: { id: stagedImportId },
            data: { progress: 0 },
        });
        await job.updateProgress(0);

        // ─── 3. Count promotable rows (cheap — no data loaded into heap) ─────
        const isPartialCommit = Array.isArray(rowIds) && rowIds.length > 0;
        // Only CONFIRMED rows commit. POTENTIAL_DUPLICATE and DUPLICATE rows
        // must first be explicitly confirmed through the Review UI (which flips
        // their status to CONFIRMED). This preserves `Transaction.externalId`
        // @unique as the ultimate defense-in-depth guard against duplicate ledger
        // entries — any row reaching this query has passed human review.
        const rowWhere = {
            stagedImportId,
            status: 'CONFIRMED',
            suggestedCategoryId: { not: null },
            ...(isPartialCommit && { id: { in: rowIds } }),
        };

        const totalConfirmed = await prisma.stagedImportRow.count({ where: rowWhere });

        if (totalConfirmed === 0) {
            // No CONFIRMED rows to promote — check remaining
            const remainingCount = await prisma.stagedImportRow.count({
                where: {
                    stagedImportId,
                    status: { in: ['CONFIRMED', 'PENDING', 'POTENTIAL_DUPLICATE'] },
                    suggestedCategoryId: { not: null },
                },
            });

            const finalStatus = (!isPartialCommit && remainingCount === 0) ? 'COMMITTED' : 'READY';
            await prisma.stagedImport.update({
                where: { id: stagedImportId },
                data: {
                    status: finalStatus,
                    progress: 100,
                    errorDetails: { commitResult: { transactionCount: 0, updateCount: 0, remaining: remainingCount } },
                },
            });
            await job.updateProgress(100);

            logger.info(`[CommitWorker] No confirmed rows for ${stagedImportId}. Status → ${finalStatus}`);
            return { stagedImportId, transactionCount: 0, remaining: remainingCount };
        }

        // ─── 4. Batch-fetch, create, and mark SKIPPED ───────────────────────
        // Each iteration fetches the next COMMIT_BATCH_SIZE CONFIRMED rows.
        // Marking them SKIPPED before the next fetch advances the window
        // without skip/offset — memory stays bounded at O(COMMIT_BATCH_SIZE).
        let totalCreated = 0;
        let totalUpdated = 0;
        let totalFetched = 0;
        let batchNumber = 0;
        const totalBatches = Math.ceil(totalConfirmed / COMMIT_BATCH_SIZE);

        // Accumulate data needed for the downstream TRANSACTIONS_IMPORTED event.
        const affectedAccountIds = new Set();
        const dateScopeMap = new Map(); // `${year}-${month}` → { year, month }

        // Cross-batch occurrence counter: when multiple CONFIRMED rows in this
        // commit share the same base hash (e.g. 7 × "$1 Commission" on the same
        // day that the user explicitly confirmed), the 2nd+ occurrences get
        // suffixed externalIds: 2nd → baseHash:2, 3rd → baseHash:3, etc. This
        // is intentionally scoped to a single commit — we still want `externalId
        // @unique` to reject re-commits of rows that were already promoted in a
        // previous commit. Any row reaching this loop must already be CONFIRMED
        // (duplicate-flagged rows are filtered upstream in rowWhere).
        const hashOccurrenceCount = new Map(); // baseHash → count seen so far

        while (true) {
            const batch = await prisma.stagedImportRow.findMany({
                where: rowWhere,
                orderBy: { rowNumber: 'asc' },
                take: COMMIT_BATCH_SIZE,
            });

            if (batch.length === 0) break;

            batchNumber++;

            // Partition: rows with updateTargetId are updates, rest are creates
            const createRows = batch.filter((r) => !r.updateTargetId);
            const updateRows = batch.filter((r) => !!r.updateTargetId);

            // 4a. Filter + map rows to transaction data (CREATE rows only).
            const rowIdToExternalId = new Map(); // rowId → externalId
            const transactionData = [];

            for (const row of createRows) {
                if (row.requiresEnrichment && (!row.ticker || row.assetQuantity == null || row.assetPrice == null)) {
                    logger.warn(`[CommitWorker] Skipping row ${row.id} — requiresEnrichment=true, ticker=${row.ticker}, qty=${row.assetQuantity}, price=${row.assetPrice}`);
                    continue;
                }
                const date = new Date(row.transactionDate);
                const amount = row.debit || row.credit;
                const baseHash = computeTransactionHash(date, row.description, amount, row.accountId);

                // Occurrence counter: make externalId unique per occurrence
                const occurrence = (hashOccurrenceCount.get(baseHash) || 0) + 1;
                hashOccurrenceCount.set(baseHash, occurrence);
                const externalId = occurrence === 1 ? baseHash : `${baseHash}:${occurrence}`;

                if (occurrence > 1) {
                    logger.info(`[CommitWorker] Occurrence #${occurrence} of hash for row ${row.id} in batch ${batchNumber} — externalId: ...${externalId.slice(-12)}`);
                }

                rowIdToExternalId.set(row.id, externalId);
                transactionData.push({
                    transaction_date: date,
                    year: date.getFullYear(),
                    month: date.getMonth() + 1,
                    day: date.getDate(),
                    quarter: `Q${Math.ceil((date.getMonth() + 1) / 3)}`,
                    categoryId: row.suggestedCategoryId,
                    description: row.description || '',
                    details: row.details || '',
                    credit: row.credit ? parseFloat(row.credit) : null,
                    debit: row.debit ? parseFloat(row.debit) : null,
                    currency: row.currency || 'USD',
                    accountId: row.accountId,
                    tenantId,
                    userId,
                    source: 'CSV',
                    externalId,
                    // Investment enrichment fields
                    ...(row.ticker && /[a-zA-Z]/.test(row.ticker) && { ticker: row.ticker }),
                    ...(row.assetQuantity != null && { assetQuantity: parseFloat(row.assetQuantity) }),
                    ...(row.assetPrice != null && { assetPrice: parseFloat(row.assetPrice) }),
                    // Ticker resolution metadata
                    ...(row.isin && { isin: row.isin }),
                    ...(row.exchange && { exchange: row.exchange }),
                    ...(row.assetCurrency && { assetCurrency: row.assetCurrency }),
                });
            }

            // 4b. Pre-check: find which externalIds already exist so we can identify
            // rows that createMany will silently skip via skipDuplicates.
            const allExternalIds = [...rowIdToExternalId.values()].filter(Boolean);
            let preExistingExternalIds = new Set();
            if (allExternalIds.length > 0) {
                const existingTxs = await prisma.transaction.findMany({
                    where: { externalId: { in: allExternalIds }, tenantId },
                    select: { externalId: true },
                });
                preExistingExternalIds = new Set(existingTxs.map((t) => t.externalId));
            }

            // 4c. Create transactions (skipDuplicates makes this idempotent on retry)
            const { count } = await prisma.transaction.createMany({
                data: transactionData,
                skipDuplicates: true,
            });
            totalCreated += count;

            // 4d. Classify each batch row by its commit outcome and mark accordingly:
            //   • Committed successfully   → SKIPPED  (advances the cursor, hidden from review)
            //   • Duplicate externalId     → POTENTIAL_DUPLICATE (surfaces in review queue)
            //   • Enrichment data missing  → STAGED   (returns to review for data entry)
            const committedRowIds = [];
            const duplicateRowIds = [];
            const enrichmentPendingRowIds = [];

            for (const row of createRows) {
                const externalId = rowIdToExternalId.get(row.id);
                if (externalId === undefined) {
                    // Row was filtered out (missing enrichment) — send back to STAGED
                    enrichmentPendingRowIds.push(row.id);
                } else if (preExistingExternalIds.has(externalId)) {
                    // Transaction already existed — flag for user review
                    duplicateRowIds.push(row.id);
                } else {
                    // Successfully created
                    committedRowIds.push(row.id);
                }
            }

            const statusUpdates = [];
            if (committedRowIds.length > 0) {
                statusUpdates.push(
                    prisma.stagedImportRow.updateMany({
                        where: { id: { in: committedRowIds } },
                        data: { status: 'SKIPPED' },
                    })
                );
            }
            if (duplicateRowIds.length > 0) {
                statusUpdates.push(
                    prisma.stagedImportRow.updateMany({
                        where: { id: { in: duplicateRowIds } },
                        data: { status: 'POTENTIAL_DUPLICATE' },
                    })
                );
                logger.info(`[CommitWorker] Batch ${batchNumber}: ${duplicateRowIds.length} row(s) flagged as POTENTIAL_DUPLICATE`);
            }
            if (enrichmentPendingRowIds.length > 0) {
                statusUpdates.push(
                    prisma.stagedImportRow.updateMany({
                        where: { id: { in: enrichmentPendingRowIds } },
                        data: { status: 'STAGED' },
                    })
                );
                logger.info(`[CommitWorker] Batch ${batchNumber}: ${enrichmentPendingRowIds.length} row(s) returned to STAGED (missing enrichment)`);
            }
            await Promise.all(statusUpdates);

            // 4d-update. Process update rows — update existing transactions in-place
            const updatedRowIds = [];
            for (const row of updateRows) {
                try {
                    const existing = await prisma.transaction.findFirst({
                        where: { id: row.updateTargetId, tenantId },
                    });
                    if (!existing) {
                        await prisma.stagedImportRow.update({
                            where: { id: row.id },
                            data: { status: 'ERROR', errorMessage: 'Transaction was deleted before commit' },
                        });
                        continue;
                    }

                    const date = new Date(row.transactionDate);
                    await prisma.transaction.update({
                        where: { id: row.updateTargetId },
                        data: {
                            transaction_date: date,
                            year: date.getFullYear(),
                            month: date.getMonth() + 1,
                            day: date.getDate(),
                            quarter: `Q${Math.ceil((date.getMonth() + 1) / 3)}`,
                            categoryId: row.suggestedCategoryId,
                            description: row.description || '',
                            details: row.details ?? null,
                            credit: row.credit ? parseFloat(row.credit) : null,
                            debit: row.debit ? parseFloat(row.debit) : null,
                            currency: row.currency || existing.currency,
                            ...(row.ticker && /[a-zA-Z]/.test(row.ticker) ? { ticker: row.ticker } : { ticker: null }),
                            assetQuantity: row.assetQuantity != null ? parseFloat(row.assetQuantity) : null,
                            assetPrice: row.assetPrice != null ? parseFloat(row.assetPrice) : null,
                            ...(row.isin && { isin: row.isin }),
                            ...(row.exchange && { exchange: row.exchange }),
                            ...(row.assetCurrency && { assetCurrency: row.assetCurrency }),
                        },
                    });

                    // Handle tag changes for update rows
                    if (row.tags !== undefined) {
                        await prisma.transactionTag.deleteMany({ where: { transactionId: row.updateTargetId } });
                        if (Array.isArray(row.tags) && row.tags.length > 0) {
                            const resolved = await resolveTagsByName(row.tags, tenantId, userId);
                            await prisma.transactionTag.createMany({
                                data: resolved.map((t) => ({ transactionId: row.updateTargetId, tagId: t.id })),
                                skipDuplicates: true,
                            });
                        }
                    }

                    totalUpdated++;
                    updatedRowIds.push(row.id);
                } catch (err) {
                    logger.error(`[CommitWorker] Failed to update tx ${row.updateTargetId}: ${err.message}`);
                    await prisma.stagedImportRow.update({
                        where: { id: row.id },
                        data: { status: 'ERROR', errorMessage: `Update failed: ${err.message}` },
                    }).catch(() => {});
                }
            }

            // Mark successfully updated rows as SKIPPED
            if (updatedRowIds.length > 0) {
                await prisma.stagedImportRow.updateMany({
                    where: { id: { in: updatedRowIds } },
                    data: { status: 'SKIPPED' },
                });
            }

            // Convenience alias used by tag-linking and embedding steps below
            const batchRowIds = batch.map((r) => r.id);

            // 4e. Link tags to created transactions (CREATE rows only)
            const rowsWithTags = createRows.filter(
                (row) => row.tags && Array.isArray(row.tags) && row.tags.length > 0
            );
            if (rowsWithTags.length > 0) {
                const allTagNames = [...new Set(rowsWithTags.flatMap((r) => r.tags))];
                const resolvedTags = await resolveTagsByName(allTagNames, tenantId, userId);
                const tagNameToId = new Map(resolvedTags.map((t) => [t.name, t.id]));

                const externalIds = rowsWithTags.map((row) => {
                    const date = new Date(row.transactionDate);
                    const amount = row.debit || row.credit;
                    return computeTransactionHash(date, row.description, amount, row.accountId);
                });

                const createdTransactions = await prisma.transaction.findMany({
                    where: { externalId: { in: externalIds }, tenantId },
                    select: { id: true, externalId: true },
                });
                const externalIdToTxId = new Map(createdTransactions.map((t) => [t.externalId, t.id]));

                const tagLinks = [];
                for (const row of rowsWithTags) {
                    const date = new Date(row.transactionDate);
                    const amount = row.debit || row.credit;
                    const exId = computeTransactionHash(date, row.description, amount, row.accountId);
                    const txId = externalIdToTxId.get(exId);
                    if (!txId) continue;

                    for (const tagName of row.tags) {
                        const trimmedName = tagName.trim();
                        const tagId = tagNameToId.get(trimmedName);
                        if (tagId) tagLinks.push({ transactionId: txId, tagId });
                    }
                }

                if (tagLinks.length > 0) {
                    await prisma.transactionTag.createMany({ data: tagLinks, skipDuplicates: true });
                }
            }

            // 4e. Embedding feedback (fire-and-forget per batch)
            // LLM/USER_OVERRIDE rows need new embeddings (novel or user-corrected).
            // VECTOR_MATCH_GLOBAL rows also need a tenant-local embedding so future
            // classifications hit tenant-local vector match instead of the discounted
            // global tier. EXACT_MATCH and tenant-local VECTOR_MATCH are already indexed.
            const needsEmbedding = batch.filter(
                (r) => r.description && r.suggestedCategoryId &&
                    (r.classificationSource === 'LLM' ||
                     r.classificationSource === 'USER_OVERRIDE' ||
                     r.classificationSource === 'VECTOR_MATCH_GLOBAL')
            );
            if (needsEmbedding.length > 0) {
                Promise.all(
                    needsEmbedding.map((row) =>
                        categorizationService
                            .recordFeedback(row.description, row.suggestedCategoryId, tenantId)
                            .catch((err) =>
                                logger.warn(`[CommitWorker] Embedding feedback failed for "${row.description}": ${err.message}`)
                            )
                    )
                ).catch(() => {});
            }

            // 4e-bis. Write DescriptionMapping for ALL committed rows (fire-and-forget).
            // recordFeedback above only covers LLM/USER_OVERRIDE rows. EXACT_MATCH and
            // VECTOR_MATCH rows also need mappings for descriptions not yet in the table.
            for (const row of batch) {
                if (row.description && row.suggestedCategoryId) {
                    addDescriptionEntry(row.description, row.suggestedCategoryId, tenantId);
                }
            }

            // 4f. Accumulate data for the downstream TRANSACTIONS_IMPORTED event
            for (const row of batch) {
                if (row.accountId) affectedAccountIds.add(row.accountId);
                if (row.transactionDate) {
                    const d = new Date(row.transactionDate);
                    const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
                    if (!dateScopeMap.has(key)) {
                        dateScopeMap.set(key, { year: d.getFullYear(), month: d.getMonth() + 1 });
                    }
                }
            }

            // 4g. Progress (0→85% across batches)
            totalFetched += batch.length;
            const batchProgress = Math.round((totalFetched / totalConfirmed) * 85);
            await job.updateProgress(batchProgress);
            await prisma.stagedImport.update({
                where: { id: stagedImportId },
                data: { progress: batchProgress },
            });

            logger.info(`[CommitWorker] Batch ${batchNumber}/${totalBatches} complete: ${count} transactions created`);
        }

        await job.updateProgress(90);
        await prisma.stagedImport.update({
            where: { id: stagedImportId },
            data: { progress: 90 },
        });

        // ─── 5. Check remaining rows ────────────────────────────────────────
        // POTENTIAL_DUPLICATE = flagged during this commit run (user needs to review)
        // STAGED = returned because enrichment data was missing (user needs to complete)
        const remainingCount = await prisma.stagedImportRow.count({
            where: {
                stagedImportId,
                status: { in: ['CONFIRMED', 'PENDING', 'POTENTIAL_DUPLICATE', 'STAGED'] },
                suggestedCategoryId: { not: null },
            },
        });

        // ─── 6. Final status update ─────────────────────────────────────────
        const finalStatus = remainingCount === 0 ? 'COMMITTED' : 'READY';
        await prisma.stagedImport.update({
            where: { id: stagedImportId },
            data: {
                status: finalStatus,
                progress: 100,
                errorDetails: {
                    commitResult: { transactionCount: totalCreated, updateCount: totalUpdated, remaining: remainingCount },
                },
            },
        });
        await job.updateProgress(100);

        // ─── 7. Produce TRANSACTIONS_IMPORTED event (direct queue) ──────────
        try {
            await enqueueEvent('TRANSACTIONS_IMPORTED', {
                tenantId,
                accountIds: [...affectedAccountIds],
                dateScopes: [...dateScopeMap.values()],
                source: 'SMART_IMPORT',
            });
        } catch (eventErr) {
            // Non-fatal — transactions are committed, event can be retried
            logger.error(`[CommitWorker] Failed to enqueue TRANSACTIONS_IMPORTED event: ${eventErr.message}`);
            Sentry.captureException(eventErr);
        }

        logger.info(
            `[CommitWorker] Commit complete for ${stagedImportId}: ` +
                `${totalCreated} created, ${totalUpdated} updated, ${remainingCount} remaining. Status → ${finalStatus}`
        );
        return { stagedImportId, transactionCount: totalCreated, updateCount: totalUpdated, remaining: remainingCount };
    } catch (error) {
        // ─── Error handler: set status to ERROR ─────────────────────────────
        try {
            await prisma.stagedImport.update({
                where: { id: stagedImportId },
                data: {
                    status: 'ERROR',
                    progress: 0,
                    errorDetails: { message: error.message },
                },
            });
        } catch (updateErr) {
            logger.error(`[CommitWorker] Failed to update StagedImport ${stagedImportId} to ERROR: ${updateErr.message}`);
        }

        logger.error(`[CommitWorker] Commit failed for ${stagedImportId}: ${error.message}`);
        Sentry.captureException(error);
        throw error;
    }
};

module.exports = { processCommitJob };
