const { Worker } = require('bullmq');
const prisma = require('../../prisma/prisma');
const { getRedisConnection } = require('../utils/redis');
const logger = require('../utils/logger');
const categorizationService = require('../services/categorizationService');
const { warmDescriptionCache } = require('../utils/descriptionCache');
const { getCategoriesForTenant } = require('../utils/categoryCache');
const { getPlaidProcessingQueue } = require('../queues/plaidProcessingQueue');
const { isRateLimitError } = require('../services/llm');
const { computeTransactionHash, buildDuplicateHashSet } = require('../utils/transactionHash');
const { reportWorkerFailure } = require('../utils/workerFailureReporter');
const {
    DEFAULT_AUTO_PROMOTE_THRESHOLD,
    DEFAULT_REVIEW_THRESHOLD,
    TOP_N_SEEDS,
    PHASE2_CONCURRENCY,
} = require('../config/classificationConfig');

// processingHints that indicate an investment transaction requiring enrichment
const INVESTMENT_HINTS = new Set(['API_STOCK', 'API_CRYPTO', 'API_FUND', 'MANUAL']);

const QUEUE_NAME = 'plaid-processing';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const BACKEND_API_KEY = process.env.INTERNAL_API_KEY;

let worker;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize description for frequency grouping */
function normalizeDescription(name) {
    return (name || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Group rows by normalized description.
 * Returns Map<normalizedName, PlaidTransaction[]>
 */
function buildFrequencyMap(rows) {
    const map = new Map();
    for (const row of rows) {
        const key = normalizeDescription(row.name);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(row);
    }
    return map;
}

/**
 * Check if a PlaidTransaction is a hash-duplicate of an existing manual transaction.
 * If so, marks it as DUPLICATE and returns true. Caller should return early.
 *
 * This runs for ALL classification paths (auto-promote, CLASSIFIED, seedHeld)
 * so duplicates are caught regardless of confidence level or category type.
 */
async function checkHashDuplicate(plaidTx, result, ctx) {
    const { accountByPlaidAccountId, existingByExternalId, hashSetByAccountId, counters } = ctx;

    const localAccount = accountByPlaidAccountId.get(plaidTx.plaidAccountId) ?? null;
    if (!localAccount) return false;

    // Already linked by externalId — not a manual-entry duplicate
    const existing = existingByExternalId.get(plaidTx.plaidTransactionId) ?? null;
    if (existing) return false;

    const hashSet = hashSetByAccountId.get(localAccount.id);
    if (!hashSet) return false;

    const txDate = new Date(plaidTx.date);
    const absAmount = Math.abs(Number(plaidTx.amount));
    const hash = computeTransactionHash(
        txDate,
        plaidTx.merchantName || plaidTx.name,
        absAmount,
        localAccount.id
    );

    if (!hashSet.has(hash)) return false;

    // Duplicate of a manually-entered transaction — mark as duplicate
    await prisma.plaidTransaction.update({
        where: { id: plaidTx.id },
        data: {
            suggestedCategoryId: result.categoryId,
            aiConfidence: result.confidence,
            classificationSource: result.source,
            promotionStatus: 'DUPLICATE',
            processed: true,
        },
    });
    counters.totalClassified++;
    logger.info(`Plaid tx ${plaidTx.id} hash-dedup: matches existing manual transaction`);
    return true;
}

/**
 * Apply a pre-computed classification result to a single PlaidTransaction row.
 * Handles auto-promote (creating a Transaction record) or CLASSIFIED staging.
 * Mutates ctx.counters and ctx.feedbackCalls in-place.
 */
async function processRowWithResult(plaidTx, result, ctx) {
    const {
        tenantId, autoPromoteThreshold, categoryById,
        accountByPlaidAccountId, existingByExternalId,
        counters, feedbackCalls,
    } = ctx;

    const suggestedCategory = categoryById.get(result.categoryId);
    const isInvestmentCategory = suggestedCategory &&
        suggestedCategory.type === 'Investments' &&
        INVESTMENT_HINTS.has(suggestedCategory.processingHint);

    // ─── Hash-based dedup: catch manual-entry duplicates (ALL paths) ────
    // Must run BEFORE auto-promote so sub-threshold and investment txs are also checked.
    if (await checkHashDuplicate(plaidTx, result, ctx)) return;

    // Any source (EXACT_MATCH, VECTOR_MATCH, LLM) is eligible for auto-promote.
    // Investment transactions are NEVER auto-promoted — require user enrichment.
    const shouldAutoPromote = !isInvestmentCategory && result.confidence >= autoPromoteThreshold;

    if (shouldAutoPromote) {
        const localAccount = accountByPlaidAccountId.get(plaidTx.plaidAccountId) ?? null;
        if (localAccount) {
            const txDate = new Date(plaidTx.date);
            const year = txDate.getFullYear();
            const month = txDate.getMonth() + 1;
            const day = txDate.getDate();
            const quarter = `Q${Math.ceil(month / 3)}`;
            const plaidAmount = Number(plaidTx.amount);
            const isDebit = plaidAmount > 0;
            const absAmount = Math.abs(plaidAmount);

            const existing = existingByExternalId.get(plaidTx.plaidTransactionId) ?? null;

            if (!existing) {
                let newTxId;
                await prisma.$transaction(async (tx) => {
                    const newTx = await tx.transaction.create({
                        data: {
                            transaction_date: txDate,
                            year, quarter, month, day,
                            categoryId: result.categoryId,
                            description: plaidTx.merchantName || plaidTx.name,
                            details: plaidTx.name,
                            debit: isDebit ? absAmount : null,
                            credit: isDebit ? null : absAmount,
                            currency: plaidTx.isoCurrencyCode || 'USD',
                            accountId: localAccount.id,
                            tenantId,
                            source: 'PLAID',
                            externalId: plaidTx.plaidTransactionId,
                        },
                    });

                    await tx.plaidTransaction.update({
                        where: { id: plaidTx.id },
                        data: {
                            suggestedCategoryId: result.categoryId,
                            aiConfidence: result.confidence,
                            classificationSource: result.source,
                            classificationReasoning: result.reasoning || null,
                            promotionStatus: 'PROMOTED',
                            matchedTransactionId: newTx.id,
                            processed: true,
                        },
                    });

                    newTxId = newTx.id;
                });

                // Queue feedback — fired after full classification to avoid racing
                feedbackCalls.push([
                    plaidTx.merchantName || plaidTx.name,
                    result.categoryId,
                    tenantId,
                    newTxId,
                ]);

                counters.autoPromotedAccountIds.add(localAccount.id);
                if (!counters.autoPromotedMinYear || year < counters.autoPromotedMinYear) {
                    counters.autoPromotedMinYear = year;
                    counters.autoPromotedMinMonth = month;
                }
                counters.totalAutoPromoted++;
            } else {
                // Already promoted — just mark processed
                await prisma.plaidTransaction.update({
                    where: { id: plaidTx.id },
                    data: {
                        suggestedCategoryId: result.categoryId,
                        aiConfidence: result.confidence,
                        classificationSource: result.source,
                        classificationReasoning: result.reasoning || null,
                        promotionStatus: 'PROMOTED',
                        matchedTransactionId: existing.id,
                        processed: true,
                    },
                });
            }

            counters.totalClassified++;
            return;
        }
        // No linked account — fall through to CLASSIFIED
    }

    // ─── Standard CLASSIFIED path ─────────────────────────────────────────
    await prisma.plaidTransaction.update({
        where: { id: plaidTx.id },
        data: {
            suggestedCategoryId: result.categoryId,
            aiConfidence: result.confidence,
            classificationSource: result.source,
            classificationReasoning: result.reasoning || null,
            promotionStatus: 'CLASSIFIED',
            processed: true,
            // Investment enrichment flags
            ...(isInvestmentCategory && {
                requiresEnrichment: true,
                enrichmentType: 'INVESTMENT',
            }),
        },
    });

    counters.totalClassified++;
}

/**
 * Classify a row via the 4-tier waterfall, then stage it.
 * Used in Phase 2 where each row gets its own classify() call.
 */
async function classifyAndStageRow(plaidTx, ctx) {
    const { tenantId, reviewThreshold, counters } = ctx;
    try {
        const result = await categorizationService.classify(
            plaidTx.name,
            plaidTx.merchantName,
            tenantId,
            reviewThreshold,
            plaidTx.category,
            // Amount + currency improve LLM disambiguation for ambiguous merchants.
            // Plaid stores `amount` as positive-debit; classification doesn't care
            // about sign so the magnitude is enough.
            { amount: plaidTx.amount, currency: plaidTx.isoCurrencyCode },
        );
        await processRowWithResult(plaidTx, result, ctx);
    } catch (classifyError) {
        if (isRateLimitError(classifyError)) {
            // Transient error — leave processed=false so the row is retried on the next job run.
            // The job re-queues itself (see below) after Phase 2 when rate-limited rows exist.
            logger.warn(
                `Rate limit hit for PlaidTransaction ${plaidTx.id} ("${plaidTx.name}") — deferring to next run`
            );
            counters.totalRateLimited++;
            return;
        }
        logger.warn(
            `classifyAndStageRow failed for PlaidTransaction ${plaidTx.id} ("${plaidTx.name}"): ${classifyError.message}`
        );
        await prisma.plaidTransaction.update({
            where: { id: plaidTx.id },
            data: {
                processed: true,
                processingError: classifyError.message.substring(0, 500),
            },
        });
        counters.totalFailed++;
    }
}

// ─── Worker ───────────────────────────────────────────────────────────────────

const startPlaidProcessorWorker = () => {
    const connection = getRedisConnection();

    worker = new Worker(QUEUE_NAME, async (job) => {
        logger.info(`Starting classification job ${job.name} for Plaid Item: ${job.data.plaidItemId}`);
        const { plaidItemId, source } = job.data;
        // Quick Seed interview only makes sense for INITIAL_SYNC — the user is present in the modal.
        // For historical backfills and manual resyncs the user may be offline; holding transactions
        // in seedHeld would just silently pile them up. Skip the interview for those sources.
        const allowSeedHeld = !source || source === 'INITIAL_SYNC';

        // p-limit is ESM-only; dynamic import works inside async CJS functions
        const { default: pLimit } = await import('p-limit');

        try {
            // ─── Setup ────────────────────────────────────────────────────────
            const plaidItem = await prisma.plaidItem.findUnique({
                where: { id: plaidItemId },
                select: { tenantId: true },
            });

            if (!plaidItem) {
                logger.error(`PlaidItem ${plaidItemId} not found — skipping job`);
                return;
            }

            const { tenantId } = plaidItem;

            // Thresholds are business rules for the whole tenant
            const tenant = await prisma.tenant.findUnique({
                where: { id: tenantId },
                select: { autoPromoteThreshold: true, reviewThreshold: true },
            });
            const autoPromoteThreshold = tenant?.autoPromoteThreshold ?? DEFAULT_AUTO_PROMOTE_THRESHOLD;
            const reviewThreshold = tenant?.reviewThreshold ?? DEFAULT_REVIEW_THRESHOLD;

            // Pre-warm in-memory description cache (O(1) Tier 1 lookups)
            await warmDescriptionCache(tenantId);

            // Pre-fetch tenant categories for investment detection
            const tenantCategories = await getCategoriesForTenant(tenantId);
            const categoryById = new Map(tenantCategories.map(c => [c.id, c]));

            // Pre-fetch tenant accounts — avoids N DB queries inside the loops
            const tenantAccounts = await prisma.account.findMany({
                where: { tenantId, plaidAccountId: { not: null } },
                select: { id: true, plaidAccountId: true },
            });
            const accountByPlaidAccountId = new Map(
                tenantAccounts.map(a => [a.plaidAccountId, a])
            );

            // Shared counters (Node.js single-threaded: safe to mutate from concurrent async)
            const counters = {
                totalClassified: 0,
                totalAutoPromoted: 0,
                totalFailed: 0,
                totalRateLimited: 0, // rows skipped due to 429 — left as processed=false for retry
                autoPromotedAccountIds: new Set(),
                autoPromotedMinYear: null,
                autoPromotedMinMonth: null,
            };
            const feedbackCalls = [];

            // ─── Fetch all pending rows upfront ───────────────────────────────
            const allPending = await prisma.plaidTransaction.findMany({
                where: { plaidItemId, processed: false, promotionStatus: 'PENDING' },
                select: {
                    id: true, name: true, merchantName: true,
                    amount: true, date: true, isoCurrencyCode: true,
                    plaidAccountId: true, plaidTransactionId: true, category: true,
                },
            });

            if (allPending.length === 0) {
                logger.info(`No pending transactions for PlaidItem ${plaidItemId} — setting seedReady`);
                await prisma.plaidItem.update({ where: { id: plaidItemId }, data: { seedReady: true } });
                return;
            }

            // Batch dedup: O(1) map lookup replaces N transaction.findUnique() calls
            const allExternalIds = allPending.map(t => t.plaidTransactionId);
            const existingTxs = await prisma.transaction.findMany({
                where: { externalId: { in: allExternalIds } },
                select: { externalId: true, id: true },
            });
            const existingByExternalId = new Map(existingTxs.map(t => [t.externalId, t]));

            // ─── Hash-based dedup (catches manually-entered duplicates) ─────────
            // Build per-account hash sets so Plaid promotion detects transactions
            // that already exist from manual entry (which have externalId = null).
            const uniqueAccountIds = new Set();
            for (const row of allPending) {
                const localAccount = accountByPlaidAccountId.get(row.plaidAccountId);
                if (localAccount) uniqueAccountIds.add(localAccount.id);
            }
            // Compute date range from pending transactions to narrow dedup query
            const plaidDates = allPending.map(p => new Date(p.date)).filter(d => !isNaN(d.getTime()));
            const plaidMinDate = plaidDates.length > 0 ? new Date(Math.min(...plaidDates.map(d => d.getTime()))) : null;
            const plaidMaxDate = plaidDates.length > 0 ? new Date(Math.max(...plaidDates.map(d => d.getTime()))) : null;

            const hashSetByAccountId = new Map();
            for (const accountId of uniqueAccountIds) {
                hashSetByAccountId.set(accountId, await buildDuplicateHashSet(tenantId, accountId, plaidMinDate, plaidMaxDate));
            }

            const ctx = {
                tenantId, autoPromoteThreshold, reviewThreshold,
                categoryById, accountByPlaidAccountId, existingByExternalId,
                hashSetByAccountId, counters, feedbackCalls,
            };

            // ─── PHASE 1: Frequency-First Seed Classification ─────────────────
            // Classify one representative per unique description (most-frequent first).
            // EXACT_MATCH or any result >= autoPromoteThreshold: stage immediately (auto-promotes).
            // LLM / VECTOR_MATCH below autoPromoteThreshold: hold with seedHeld=true for interview.
            // Phase 1 stops once TOP_N_SEEDS held seeds are found or all descriptions exhausted.
            const freqMap = buildFrequencyMap(allPending);
            const sortedDesc = [...freqMap.entries()].sort((a, b) => b[1].length - a[1].length);

            let seedCount = 0;
            const phase1Start = Date.now();

            for (const [normalizedName, rows] of sortedDesc) {
                if (seedCount >= TOP_N_SEEDS) break;

                const rep = rows[0];
                try {
                    // ONE classify() call per unique description — all rows in the group
                    // share the result (the waterfall already caches via addDescriptionEntry).
                    // Amount + currency from the representative row improve LLM
                    // disambiguation; sharing across the group is fine because the
                    // grouping key already locks down the description, and amount
                    // variation within a single merchant rarely flips category.
                    const result = await categorizationService.classify(
                        rep.name, rep.merchantName, tenantId, reviewThreshold, rep.category,
                        { amount: rep.amount, currency: rep.isoCurrencyCode },
                    );

                    // Process immediately if:
                    //   - EXACT_MATCH: always trusted (user's own confirmed history)
                    //   - Any source with confidence >= autoPromoteThreshold: will auto-promote anyway
                    //   - allowSeedHeld is false (historical sync / manual resync — user not present)
                    // Otherwise hold for the Quick Seed interview (seedHeld=true) — INITIAL_SYNC only:
                    //   - LLM results (regardless of confidence — less reliable source)
                    //   - VECTOR_MATCH / VECTOR_MATCH_GLOBAL below autoPromoteThreshold
                    const shouldProcessImmediately =
                        !allowSeedHeld ||
                        result.source === 'EXACT_MATCH' ||
                        result.confidence >= autoPromoteThreshold;

                    if (shouldProcessImmediately) {
                        for (const row of rows) {
                            await processRowWithResult(row, result, ctx);
                        }
                    } else {
                        // Hold back — store the suggestion WITHOUT staging.
                        // Phase 2 skips these rows (seedHeld = true).
                        // confirm-seeds promotes them once the user confirms.
                        // But first: check each row for hash-duplicates before holding.
                        const holdIds = [];
                        for (const row of rows) {
                            if (await checkHashDuplicate(row, result, ctx)) continue;
                            holdIds.push(row.id);
                        }
                        if (holdIds.length > 0) {
                            await prisma.plaidTransaction.updateMany({
                                where: { id: { in: holdIds } },
                                data: {
                                    suggestedCategoryId: result.categoryId,
                                    aiConfidence: result.confidence,
                                    classificationSource: result.source, // LLM | VECTOR_MATCH | VECTOR_MATCH_GLOBAL
                                    classificationReasoning: result.reasoning || null,
                                    seedHeld: true,
                                    // processed: false and promotionStatus: 'PENDING' remain as-is
                                },
                            });
                            seedCount++;
                        }
                        const dedupCount = rows.length - holdIds.length;
                        logger.info(
                            `[Phase 1] Holding ${holdIds.length} row(s) for "${normalizedName}" ` +
                            `(source=${result.source}, confidence=${result.confidence.toFixed(3)}, seedCount=${seedCount})` +
                            (dedupCount > 0 ? ` — ${dedupCount} duplicate(s) removed` : '')
                        );
                    }
                } catch (classifyError) {
                    logger.warn(`Phase 1 classify failed for "${normalizedName}": ${classifyError.message}`);
                    for (const row of rows) {
                        await prisma.plaidTransaction.update({
                            where: { id: row.id },
                            data: { processed: true, processingError: classifyError.message.substring(0, 500) },
                        });
                        counters.totalFailed++;
                    }
                }
            }

            logger.info(
                `[Phase 1] Item ${plaidItemId}: ${seedCount} seeds held (LLM+VECTOR below threshold), ` +
                `${counters.totalClassified} classified/auto-promoted in ${Date.now() - phase1Start}ms`
            );

            // ─── Signal frontend: Quick Seed interview can be shown ────────────
            // seedReady = true even if seedCount = 0 (all hit Tier 1/2 — interview skipped)
            await prisma.plaidItem.update({ where: { id: plaidItemId }, data: { seedReady: true } });

            // ─── PHASE 2: Parallel Classification of Remaining Rows ───────────
            // Rows not touched by Phase 1 — sorted ASCENDING by frequency.
            // Rarest merchants classified first (LLM inevitable, no cache benefit to delay).
            // Semi-frequent descriptions processed last, maximizing the window for user's
            // seed confirmations to propagate into Tier 1 cache + Tier 2 vector index.
            const remainingPending = await prisma.plaidTransaction.findMany({
                where: {
                    plaidItemId,
                    processed: false,
                    promotionStatus: 'PENDING',
                    seedHeld: false, // Exclude Phase 1 seeds — they wait for user confirmation in the interview
                },
                select: {
                    id: true, name: true, merchantName: true,
                    amount: true, date: true, isoCurrencyCode: true,
                    plaidAccountId: true, plaidTransactionId: true, category: true,
                },
            });

            if (remainingPending.length > 0) {
                const phase2FreqMap = buildFrequencyMap(remainingPending);
                // ASCENDING: least-frequent groups first → most-frequent last
                const sortedAsc = [...phase2FreqMap.entries()]
                    .sort((a, b) => a[1].length - b[1].length)
                    .flatMap(([, rows]) => rows);

                const limit = pLimit(PHASE2_CONCURRENCY);
                const phase2Start = Date.now();

                await Promise.all(
                    sortedAsc.map(row => limit(() => classifyAndStageRow(row, ctx)))
                );

                logger.info(
                    `[Phase 2] Item ${plaidItemId}: ${remainingPending.length} rows in ${Date.now() - phase2Start}ms`
                );
            }

            logger.info(
                `Classification complete for Item ${plaidItemId}. ` +
                `${counters.totalClassified} classified, ` +
                `${counters.totalAutoPromoted} auto-promoted, ` +
                `${counters.totalFailed} failed, ` +
                `${counters.totalRateLimited} deferred (rate limited).`
            );

            // ─── Re-queue if rows were skipped due to Gemini rate limits ─────────
            // Rate-limited rows have processed=false still — a fresh job will pick them up.
            // Delay 60s to let the quota window reset before the next run.
            if (counters.totalRateLimited > 0) {
                logger.info(
                    `Re-queuing PlaidItem ${plaidItemId} in 60s to retry ${counters.totalRateLimited} rate-limited rows`
                );
                const retryQueue = getPlaidProcessingQueue();
                await retryQueue.add('PLAID_SYNC_COMPLETE', { plaidItemId, source }, { delay: 60_000 });
            }

            // ─── Fire deferred feedback calls (cache + vector embedding updates) ─
            for (const args of feedbackCalls) {
                categorizationService.recordFeedback(...args);
            }

            // ─── Emit TRANSACTIONS_IMPORTED for analytics / portfolio cache ────
            if (counters.totalAutoPromoted > 0 && counters.autoPromotedAccountIds.size > 0) {
                try {
                    const response = await fetch(`${BACKEND_URL}/api/events`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-api-key': BACKEND_API_KEY,
                        },
                        body: JSON.stringify({
                            type: 'TRANSACTIONS_IMPORTED',
                            tenantId,
                            accountIds: [...counters.autoPromotedAccountIds],
                            dateScope: {
                                year: counters.autoPromotedMinYear,
                                month: counters.autoPromotedMinMonth,
                            },
                            source: 'PLAID_AUTO_PROMOTE',
                        }),
                    });
                    if (!response.ok) {
                        logger.warn(`TRANSACTIONS_IMPORTED event returned ${response.status}`);
                    }
                } catch (eventErr) {
                    logger.error(`Failed to emit TRANSACTIONS_IMPORTED after auto-promote: ${eventErr.message}`);
                }
            }

        } catch (error) {
            logger.error(`Error processing Plaid Item ${plaidItemId}: ${error.message}`);
            throw error;
        }
    }, {
        connection,
        concurrency: 1, // One Plaid item at a time to respect AI rate limits
        lockDuration: 600_000,  // 10 min — large syncs with 200+ transactions and LLM calls need time
        lockRenewTime: 150_000, // renew every 2.5 min (well before 10 min expiry)
    });

    worker.on('failed', (job, err) => {
        reportWorkerFailure({
            workerName: 'plaidProcessorWorker',
            job,
            error: err,
            extra: { plaidItemId: job?.data?.plaidItemId },
        });
    });

    logger.info(`Plaid Processor Worker started on queue: ${QUEUE_NAME}`);

    // Return worker reference so index.js can close it before disconnecting Redis
    return worker;
};

module.exports = { startPlaidProcessorWorker, normalizeDescription, buildFrequencyMap };
