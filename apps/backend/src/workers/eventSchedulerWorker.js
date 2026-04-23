const Sentry = require('@sentry/node');
const { Worker } = require('bullmq');
const logger = require('../utils/logger');
const { getRedisConnection } = require('../utils/redis');
const { getEventsQueue, EVENTS_QUEUE_NAME, enqueueEvent } = require('../queues/eventsQueue');
const { getPortfolioQueue } = require('../queues/portfolioQueue');
const { getAnalyticsQueue } = require('../queues/analyticsQueue');
const { getPlaidSyncQueue } = require('../queues/plaidSyncQueue');
const { getSmartImportQueue } = require('../queues/smartImportQueue');
const { scheduleDebouncedJob } = require('../services/debounceService');
const { reportWorkerFailure } = require('../utils/workerFailureReporter');

const DEBOUNCE_DELAY_SECONDS = 5; // 5 seconds

const processEventJob = async (job) => {
    const { name, data } = job;
    // Structured event log — exposes tenantId + source + jobId up front so
    // downstream triggers (e.g. portfolio rebuilds) can be traced back to
    // their originating API route, worker, or cron. If `source` is missing
    // here, the producer should be updated to pass it through.
    logger.info('Event received', {
        type: name,
        jobId: job.id,
        tenantId: data?.tenantId || null,
        source: data?.source || null,
        keys: data ? Object.keys(data) : [],
    });
    const redis = getRedisConnection();

    // This is a new helper function to transform the debounced scopes array.
    const consolidateScopes = (scopes) => {
        if (!scopes || scopes.length === 0) {
            return null;
        }

        let earliestDate = new Date();
        const filters = { type: [], group: [], currency: [], country: [] };

        scopes.forEach(scope => {
            const scopeDate = new Date(scope.year, (scope.month || 1) - 1, 1);
            if (scopeDate < earliestDate) {
                earliestDate = scopeDate;
            }
            if (scope.type && !filters.type.includes(scope.type)) filters.type.push(scope.type);
            if (scope.group && !filters.group.includes(scope.group)) filters.group.push(scope.group);
            if (scope.currency && !filters.currency.includes(scope.currency)) filters.currency.push(scope.currency);
            if (scope.country && !filters.country.includes(scope.country)) filters.country.push(scope.country);
        });

        // Clean up empty filter arrays
        Object.keys(filters).forEach(key => {
            if (filters[key].length === 0) {
                delete filters[key];
            }
        });

        return {
            earliestDate: earliestDate.toISOString().slice(0, 10),
            filters: filters,
        };
    };

    try {
        switch (name) {
            case 'SMART_IMPORT_REQUESTED': {
                const { tenantId: siTenantId, userId: siUserId, accountId: siAccountId, adapterId, fileStorageKey: siFileKey, stagedImportId } = data;
                if (!siTenantId || !siUserId || !siFileKey || !stagedImportId) {
                    logger.warn('SMART_IMPORT_REQUESTED event is missing required data.');
                    return;
                }
                const smartImportJobId = `smart-import-${siTenantId}-${Date.now()}`;
                await getSmartImportQueue().add('process-smart-import', {
                    tenantId: siTenantId,
                    userId: siUserId,
                    accountId: siAccountId,
                    adapterId,
                    fileStorageKey: siFileKey,
                    stagedImportId,
                }, { jobId: smartImportJobId });
                logger.info(`[Event] Enqueued smart import job ${smartImportJobId} for staged import ${stagedImportId}`);
                break;
            }

            case 'SMART_IMPORT_COMMIT': {
                const { tenantId: scTenantId, userId: scUserId, stagedImportId: scStagedImportId, rowIds: scRowIds } = data;
                if (!scTenantId || !scUserId || !scStagedImportId) {
                    logger.warn('SMART_IMPORT_COMMIT event is missing required data.');
                    return;
                }
                const commitJobId = `smart-import-commit-${scStagedImportId}-${Date.now()}`;
                await getSmartImportQueue().add('commit-smart-import', {
                    tenantId: scTenantId,
                    userId: scUserId,
                    stagedImportId: scStagedImportId,
                    rowIds: scRowIds || null,
                }, { jobId: commitJobId });
                logger.info(`[Event] Enqueued smart import commit job ${commitJobId} for staged import ${scStagedImportId}`);
                break;
            }

            case 'PLAID_INITIAL_SYNC':
            case 'PLAID_SYNC_UPDATES': {
                const { plaidItemId, tenantId, source } = data;
                if (!plaidItemId) {
                    logger.warn(`${name} event is missing plaidItemId.`);
                    return;
                }
                logger.info(`[Event] Scheduling Plaid Sync for Item ${plaidItemId} (Type: ${name}, Source: ${source || 'N/A'})`);
                await getPlaidSyncQueue().add('plaid-sync-job', { plaidItemId, tenantId, source });
                break;
            }

            case 'PLAID_HISTORICAL_BACKFILL': {
                const { plaidItemId, tenantId, fromDate } = data;
                if (!plaidItemId || !fromDate) {
                    logger.warn('PLAID_HISTORICAL_BACKFILL event is missing required data.');
                    return;
                }
                logger.info(`[Event] Scheduling Plaid historical backfill for Item ${plaidItemId}, fromDate=${fromDate}`);
                await getPlaidSyncQueue().add('plaid-sync-job', { plaidItemId, tenantId, source: 'HISTORICAL_BACKFILL', fromDate });
                break;
            }

            case 'MANUAL_PORTFOLIO_PRICE_UPDATED': {
                const { tenantId, portfolioItemId } = data;
                if (!portfolioItemId) {
                    logger.warn('MANUAL_PORTFOLIO_PRICE_UPDATED event is missing portfolioItemId.');
                    return;
                }

                // Use the new, smart debouncing service
                await scheduleDebouncedJob(
                    getPortfolioQueue(),
                    'recalculate-portfolio-items', // The new, correct, batched job name
                    { tenantId, portfolioItemIds: [portfolioItemId] },
                    'portfolioItemIds', // The key for aggregation
                    DEBOUNCE_DELAY_SECONDS
                );
                break;
            }

            case 'MANUAL_TRANSACTION_MODIFIED': // Fall-through
            case 'MANUAL_TRANSACTION_CREATED': {
                const { tenantId, transactionId, categoryType, transaction_date, currency, country, categoryGroup } = data;
                if (!tenantId || !transactionId) {
                    logger.warn(`${name} event is missing tenantId or transactionId.`);
                    return;
                }

                // Path A: For transactions that affect complex portfolio items (Investments/Debt).
                // These MUST run through the portfolio processor first to link the transaction to an item.
                if (['Investments', 'Debt'].includes(categoryType)) {
                    logger.info(`[Event] Routing Investment/Debt transaction to portfolio processor.`);
                    await getPortfolioQueue().add('process-portfolio-changes', { tenantId, transactionId });
                    // Cash processing will be triggered by PORTFOLIO_CHANGES_PROCESSED

                } else {
                    // Path B: For simple transactions that affect cash + analytics.
                    // All simple transactions affect cash, so process cash first.
                    logger.info(`[Event] Routing simple transaction to cash processor first.`);
                    const date = new Date(transaction_date);
                    const cashScope = {
                        currency,
                        year: date.getFullYear()
                    };

                    const analyticsScope = {
                        year: date.getFullYear(),
                        month: date.getMonth() + 1,
                        currency,
                        country,
                        type: categoryType,
                        group: categoryGroup
                    };

                    const finalScope = consolidateScopes([analyticsScope]);

                    await scheduleDebouncedJob(
                        getPortfolioQueue(),
                        'process-cash-holdings',
                        { tenantId, scope: cashScope, originalScope: finalScope, needsCashRebuild: [true] },
                        'needsCashRebuild',
                        DEBOUNCE_DELAY_SECONDS
                    );
                    // Analytics will be triggered by CASH_HOLDINGS_PROCESSED
                }
                break;
            }

            case 'TRANSACTIONS_IMPORTED': {
                const { tenantId, accountIds, dateScopes, dateScope, source } = data;
                if (!tenantId) {
                    logger.warn('TRANSACTIONS_IMPORTED event is missing tenantId.');
                    return;
                }
                // Normalize dateScope (single from individual promote) into dateScopes array
                const resolvedDateScopes = dateScopes || (dateScope ? [dateScope] : undefined);
                logger.info(`[Event] Received TRANSACTIONS_IMPORTED for tenant ${tenantId}, source=${source || 'unknown'}, accounts=${accountIds?.length || 'all'}. Scheduling portfolio processor.`);
                await scheduleDebouncedJob(
                    getPortfolioQueue(),
                    'process-portfolio-changes',
                    {
                        tenantId,
                        needsSync: [true],
                        ...(accountIds && accountIds.length > 0 && { accountIds }),
                        ...(resolvedDateScopes && resolvedDateScopes.length > 0 && { dateScopes: resolvedDateScopes }),
                    },
                    'needsSync',
                    DEBOUNCE_DELAY_SECONDS * 2
                );
                break;
            }

            case 'PORTFOLIO_CHANGES_PROCESSED': {
                const { tenantId, isFullRebuild, portfolioItemIds, dateScopes, _rebuildMeta } = data;
                if (!tenantId) {
                    logger.warn('PORTFOLIO_CHANGES_PROCESSED event is missing tenantId.');
                    return;
                }

                if (isFullRebuild) {
                    // Trigger cash processing first, then analytics will be triggered by CASH_HOLDINGS_PROCESSED
                    logger.info(`[Event] Portfolio changes processed (full rebuild) for tenant ${tenantId}. Scheduling full cash processing.`);
                    await scheduleDebouncedJob(
                        getPortfolioQueue(),
                        'process-cash-holdings',
                        { tenantId, needsCashRebuild: [true], ...(_rebuildMeta ? { _rebuildMeta } : {}) },
                        'needsCashRebuild',
                        DEBOUNCE_DELAY_SECONDS
                    );
                } else if (dateScopes && dateScopes.length > 0) {
                    // For scoped updates, determine if we need cash processing
                    const finalScope = consolidateScopes(dateScopes);

                    // Scope by year + currency when possible. When exactly one currency
                    // is in scope, pass it through so the cash processor only rebuilds
                    // that currency. Multiple currencies fall back to processing all.
                    const cashScope = {
                        year: new Date(finalScope.earliestDate).getFullYear(),
                        ...(finalScope.filters?.currency?.length === 1 && { currency: finalScope.filters.currency[0] }),
                    };

                    logger.info(`[Event] Portfolio changes processed (scoped) for tenant ${tenantId}. Scheduling scoped cash processing.`);
                    await scheduleDebouncedJob(
                        getPortfolioQueue(),
                        'process-cash-holdings',
                        { tenantId, scope: cashScope, originalScope: finalScope, portfolioItemIds, needsCashRebuild: [true], ...(_rebuildMeta ? { _rebuildMeta } : {}) },
                        'needsCashRebuild',
                        DEBOUNCE_DELAY_SECONDS
                    );
                }
                break;
            }

            case 'CASH_HOLDINGS_PROCESSED': {
                const { tenantId, isFullRebuild, scope, originalScope, portfolioItemIds, _rebuildMeta } = data;
                if (!tenantId) {
                    logger.warn('CASH_HOLDINGS_PROCESSED event is missing tenantId.');
                    return;
                }

                if (isFullRebuild) {
                    // Trigger full analytics rebuild (without cash logic)
                    logger.info(`[Event] Cash holdings processed (full rebuild) for tenant ${tenantId}. Scheduling full analytics.`);
                    await scheduleDebouncedJob(
                        getAnalyticsQueue(),
                        'full-rebuild-analytics',
                        { tenantId, needsRecalc: [true], ...(_rebuildMeta ? { _rebuildMeta } : {}) },
                        'needsRecalc',
                        DEBOUNCE_DELAY_SECONDS
                    );
                } else if (originalScope || portfolioItemIds) {
                    // Trigger scoped analytics with original scope
                    logger.info(`[Event] Cash holdings processed (scoped) for tenant ${tenantId}. Scheduling scoped analytics.`);
                    await scheduleDebouncedJob(
                        getAnalyticsQueue(),
                        'scoped-update-analytics',
                        { tenantId, scopes: [originalScope], portfolioItemIds, ...(_rebuildMeta ? { _rebuildMeta } : {}) },
                        'scopes',
                        DEBOUNCE_DELAY_SECONDS
                    );
                }
                break;
            }

            case 'ANALYTICS_RECALCULATION_COMPLETE': {
                const { tenantId, portfolioItemIds, isFullRebuild, _rebuildMeta } = data;
                if (!tenantId) {
                    logger.warn('ANALYTICS_RECALCULATION_COMPLETE event is missing tenantId.');
                    return;
                }

                // Manual `full-analytics` rebuild: user asked for analytics
                // only, so suppress the downstream valuation cascade.
                // (Manual `scoped-analytics` doesn't have `isFullRebuild=true`,
                // so it naturally falls into the scoped branch which only
                // re-values explicitly-affected items — no special-case
                // suppression needed there.)
                if (_rebuildMeta?.rebuildType === 'full-analytics') {
                    logger.info(`[Event] Analytics recalculation complete (manual full-analytics) for tenant ${tenantId}. Suppressing valuation cascade per admin request.`);
                    break;
                }

                if (isFullRebuild) {
                    // This is a full rebuild, so trigger a full valuation for ALL assets.
                    // The valuation worker will now handle cash vs. non-cash assets correctly.
                    // `value-all-assets` carries `_rebuildMeta` through so its
                    // completion handler can release the full-portfolio
                    // single-flight lock (see `utils/rebuildLock.js`). The
                    // loan processors run independently and don't gate lock
                    // release.
                    logger.info(`Analytics recalculation complete (full) for tenant ${tenantId}. Enqueuing full valuation for ALL assets.`);
                    await getPortfolioQueue().add('value-all-assets', {
                        tenantId,
                        ...(_rebuildMeta ? { _rebuildMeta } : {}),
                    });
                    await getPortfolioQueue().add('process-amortizing-loan', { tenantId });
                    await getPortfolioQueue().add('process-simple-liability', { tenantId });
                } else if (portfolioItemIds && portfolioItemIds.length > 0) {
                    // This is a true scoped update (e.g., from a manual transaction).
                    logger.info(`Analytics recalculation complete (scoped) for tenant ${tenantId}. Enqueuing scoped valuation.`);
                    await getPortfolioQueue().add('value-portfolio-items', { tenantId, portfolioItemIds });
                }
                break;
            }

            case 'TAG_ASSIGNMENT_MODIFIED': {
                const { tenantId: tagTenantId, transactionScopes } = data;
                if (!tagTenantId) {
                    logger.warn('TAG_ASSIGNMENT_MODIFIED event is missing tenantId.');
                    return;
                }
                // Route through the existing analytics queue as a scoped update.
                // The analytics worker now populates both regular and tag analytics in one pass.
                logger.info(`[Event] Tag assignment modified for tenant ${tagTenantId}. Scheduling scoped analytics.`);
                await scheduleDebouncedJob(
                    getAnalyticsQueue(),
                    'scoped-update-analytics',
                    { tenantId: tagTenantId, scopes: transactionScopes || [] },
                    'scopes',
                    DEBOUNCE_DELAY_SECONDS
                );
                break;
            }

            case 'PORTFOLIO_STALE_REVALUATION': {
                const { tenantId: staleTenantId } = data;
                if (!staleTenantId) {
                    logger.warn('PORTFOLIO_STALE_REVALUATION event is missing tenantId.');
                    return;
                }
                // Debounce with a 30-minute window per tenant to prevent rapid re-triggers
                // (e.g., user refreshing the portfolio page multiple times)
                // NOTE: We intentionally skip `process-cash-holdings` here. Cash holdings
                // haven't changed (no new transactions), and that job emits
                // CASH_HOLDINGS_PROCESSED which cascades into a full analytics rebuild +
                // a second valuation run. The `value-all-assets` job already handles cash
                // assets via its forward-fill logic in the valuation engine.
                // Use a date-scoped jobId so BullMQ deduplicates within the same day.
                // This prevents the infinite-rebuild loop where `value-all-assets` deletes
                // all history (triggering another staleness check) before it finishes rebuilding.
                const today = new Date().toISOString().split('T')[0];
                const dedupePrefix = `stale-revalue-${staleTenantId}-${today}`;

                logger.info(`[Event] Portfolio history stale for tenant ${staleTenantId}. Scheduling on-demand revaluation (dedupe: ${dedupePrefix}).`);
                await scheduleDebouncedJob(
                    getPortfolioQueue(),
                    'value-all-assets',
                    { tenantId: staleTenantId, needsRevaluation: [true] },
                    'needsRevaluation',
                    1800 // 30 minutes
                );
                await getPortfolioQueue().add('process-simple-liability', { tenantId: staleTenantId }, { jobId: `${dedupePrefix}-liability` });
                await getPortfolioQueue().add('process-amortizing-loan', { tenantId: staleTenantId }, { jobId: `${dedupePrefix}-amortizing` });
                break;
            }

            case 'TENANT_CURRENCY_SETTINGS_UPDATED': {
                const { tenantId } = data;
                if (!tenantId) {
                    logger.warn('TENANT_CURRENCY_SETTINGS_UPDATED event is missing tenantId.');
                    return;
                }
                logger.info(`[Event] Received TENANT_CURRENCY_SETTINGS_UPDATED for tenant ${tenantId}. Scheduling full portfolio rebuild.`);

                // Schedule a full portfolio rebuild. The chain will handle analytics and valuation.
                await scheduleDebouncedJob(
                    getPortfolioQueue(),
                    'process-portfolio-changes',
                    { tenantId, needsSync: [true] },
                    'needsSync',
                    DEBOUNCE_DELAY_SECONDS * 2
                );

                break;
            }

            case 'MANUAL_REBUILD_REQUESTED': {
                // Admin-triggered rebuild from the settings Maintenance UI.
                // Unlike the other event types (which carry implicit cause
                // semantics — e.g. "currency settings changed"), this event
                // is an explicit operator request that can target one of
                // four scopes. The `_rebuildMeta` marker attached to the
                // downstream job data lets us filter BullMQ's completed
                // queue for rebuild history, and per-job `removeOnComplete`
                // overrides keep that history available for 30 days
                // without bloating Redis with every routine cron run.
                const { tenantId, scope, requestedBy, requestedAt, payload } = data;
                if (!tenantId || !scope) {
                    logger.warn('MANUAL_REBUILD_REQUESTED event is missing tenantId or scope.');
                    return;
                }

                const rebuildMeta = {
                    requestedBy: requestedBy || null,
                    requestedAt: requestedAt || new Date().toISOString(),
                    rebuildType: scope,
                };
                // 30-day retention specifically for manual rebuilds so the
                // maintenance-tab history can show last month's operations.
                const RETENTION_SECONDS = 30 * 24 * 3600;
                const retentionOpts = {
                    removeOnComplete: { age: RETENTION_SECONDS },
                    removeOnFail: { age: RETENTION_SECONDS },
                };
                // Dedupe ID: timestamp-per-scope lets the same admin re-run
                // a rebuild after a completed one finishes, while preventing
                // double-clicks from double-enqueueing.
                const jobId = `manual-rebuild-${scope}-${tenantId}-${Date.now()}`;

                logger.info(`[Event] MANUAL_REBUILD_REQUESTED received`, { tenantId, scope, requestedBy });

                switch (scope) {
                    case 'full-portfolio': {
                        // Kicks off the same cascade as TENANT_CURRENCY_SETTINGS_UPDATED:
                        // process-portfolio-changes → cash-holdings → full-rebuild-analytics → value-all-assets.
                        await getPortfolioQueue().add(
                            'process-portfolio-changes',
                            { tenantId, _rebuildMeta: rebuildMeta },
                            { jobId, ...retentionOpts },
                        );
                        break;
                    }
                    case 'full-analytics': {
                        // Jumps straight to a full analytics rebuild, skipping
                        // the portfolio-changes leg. Use when analytics cache
                        // is stale but valuations are already current (e.g.
                        // the March-rows-missing scenario from 2026-04-22).
                        await getAnalyticsQueue().add(
                            'full-rebuild-analytics',
                            { tenantId, _rebuildMeta: rebuildMeta },
                            { jobId, ...retentionOpts },
                        );
                        break;
                    }
                    case 'scoped-analytics': {
                        // Scoped analytics rebuild from a given start date.
                        // Matches the existing `scope.earliestDate` shape
                        // consumed by analyticsWorker's Pass 1/2 filters.
                        const { earliestDate } = payload || {};
                        if (!earliestDate) {
                            logger.warn('MANUAL_REBUILD_REQUESTED (scoped-analytics) missing payload.earliestDate.');
                            return;
                        }
                        await getAnalyticsQueue().add(
                            'scoped-update-analytics',
                            {
                                tenantId,
                                scopes: [{ earliestDate }],
                                _rebuildMeta: rebuildMeta,
                            },
                            { jobId, ...retentionOpts },
                        );
                        break;
                    }
                    case 'single-asset': {
                        // Re-value one portfolio item (asset). Uses the
                        // existing `value-portfolio-items` job which accepts
                        // a `portfolioItemIds` array.
                        const { portfolioItemId } = payload || {};
                        if (!portfolioItemId) {
                            logger.warn('MANUAL_REBUILD_REQUESTED (single-asset) missing payload.portfolioItemId.');
                            return;
                        }
                        await getPortfolioQueue().add(
                            'value-portfolio-items',
                            {
                                tenantId,
                                portfolioItemIds: [portfolioItemId],
                                _rebuildMeta: rebuildMeta,
                            },
                            { jobId, ...retentionOpts },
                        );
                        break;
                    }
                    default:
                        logger.warn(`Unknown MANUAL_REBUILD_REQUESTED scope: ${scope}`);
                }
                break;
            }

            default:
                logger.warn(`Unknown event job name: ${name}`);
        }
    } catch (error) {
        logger.error(`Error processing event ${name} for job ${job.id}:`, { message: error.message, stack: error.stack, jobData: job.data });
        throw error;
    }
};

const startEventSchedulerWorker = () => {
    logger.info('Starting Event Scheduler Worker...');
    const worker = new Worker(EVENTS_QUEUE_NAME, processEventJob, {
        connection: getRedisConnection(),
        concurrency: 1, // Process events one by one to maintain order and debounce logic
    });

    worker.on('completed', (job) => { logger.info(`Event job completed: ${job.name}`); });
    worker.on('failed', (job, err) => {
        reportWorkerFailure({
            workerName: 'eventSchedulerWorker',
            job,
            error: err,
            extra: { jobData: job?.data },
        });
    });

    // Return worker reference so index.js can close it before disconnecting Redis
    return worker;
};

module.exports = { startEventSchedulerWorker, enqueueEvent, processEventJob }; 