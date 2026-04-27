const Sentry = require('@sentry/node');
const { Worker } = require('bullmq');
const logger = require('../utils/logger');
const { getRedisConnection } = require('../utils/redis');
const { PORTFOLIO_QUEUE_NAME, getPortfolioQueue } = require('../queues/portfolioQueue');
const prisma = require('../../prisma/prisma');
const { reportWorkerFailure } = require('../utils/workerFailureReporter');
const { createHeartbeat } = require('../utils/jobHeartbeat');
const { maybeReleaseRebuildLock } = require('../utils/rebuildLock');

const processPortfolioChanges = require('./portfolio-handlers/process-portfolio-changes');
const simpleLiabilityProcessor = require('./portfolio-handlers/simple-liability-processor');
const processAmortizingLoan = require('./portfolio-handlers/amortizing-loan-processor');
const generatePortfolioValuation = require('./portfolio-handlers/valuation/index.js');
const { processCashHoldings } = require('./portfolio-handlers/cash-processor');

const processPortfolioJob = async (job, token) => {
    const { name, data } = job;
    logger.info(`Processing portfolio job: ${name}`, { data });

    // Attach an explicit lock heartbeat to the job so downstream handlers
    // — including those invoked via the `{ ...job, data: ... }` spread
    // pattern — can call `job.heartbeat()` at natural yield points
    // (per-asset loop iterations, per-batch writes). BullMQ v5's
    // auto-renew at lockDuration/2 can miss its window under Prisma
    // Accelerate retry storms, which is what caused the "could not renew
    // lock for job <id>" errors during long full-rebuild chains.
    job.heartbeat = createHeartbeat(job, token, {
        intervalMs: 60_000,
        lockDurationMs: 300_000,
        name: 'portfolioWorker',
    });

    try {
        switch (name) {
            case 'process-portfolio-changes':
                return await processPortfolioChanges(job);
            
            case 'process-cash-holdings': {
                const { tenantId, scope, originalScope, portfolioItemIds, _rebuildMeta } = data;
                // Merge originalScope and portfolioItemIds into scope so the cash processor
                // can include them in the CASH_HOLDINGS_PROCESSED event it emits, which
                // allows the event scheduler to correctly trigger scoped analytics downstream.
                // `_rebuildMeta` is also forwarded so the admin-rebuild chain stays
                // traceable through to `value-all-assets` (lock release on completion).
                const enrichedScope = {
                    ...scope,
                    ...(originalScope !== undefined && { originalScope }),
                    ...(portfolioItemIds !== undefined && { portfolioItemIds }),
                    ...(_rebuildMeta ? { _rebuildMeta } : {}),
                };
                return await processCashHoldings(tenantId, enrichedScope);
            }
            /*
            case 'recalculate-portfolio-item':
                await recalculatePortfolioItem(job);
                const item = await prisma.portfolioItem.findUnique({ 
                    where: { id: data.portfolioItemId }, 
                    include: { category: true, debtTerms: true } 
                });
                if (!item) return;

                const jobData = { ...data, tenantId: item.tenantId, debts: [item] };

                if (item.category?.type === 'Investments') {
                    // Assuming investments might need a similar fix if they are recalculated individually
                    return await generatePortfolioValuation({ ...job, data: { ...data, tenantId: item.tenantId, assets: [item] } });
                } else if (item.category?.processingHint === 'SIMPLE_LIABILITY') {
                    return await simpleLiabilityProcessor({ ...job, data: jobData });
                } else if (item.category?.processingHint === 'AMORTIZING_LOAN') {
                    return await processAmortizingLoan({ ...job, data: jobData });
                }
                return;
            */
            case 'process-simple-liability': {
                const debts = await prisma.portfolioItem.findMany({
                    where: { tenantId: data.tenantId, category: { processingHint: 'SIMPLE_LIABILITY' } }
                });
                if (debts.length === 0) {
                    logger.info(`[PortfolioWorker] No simple liabilities found for tenant ${data.tenantId}. Skipping job.`);
                    return { success: true, processed: 0 };
                }
                return await simpleLiabilityProcessor({ ...job, data: { ...data, debts } });
            }
            case 'process-amortizing-loan': {
                const debts = await prisma.portfolioItem.findMany({
                    where: { tenantId: data.tenantId, category: { processingHint: 'AMORTIZING_LOAN' } }
                });
                if (debts.length === 0) {
                    logger.info(`[PortfolioWorker] No amortizing loans found for tenant ${data.tenantId}. Skipping job.`);
                    return { success: true, processed: 0 };
                }
                return await processAmortizingLoan({ ...job, data: { ...data, debts } });
            }
            case 'value-portfolio-items': {
                const { tenantId, portfolioItemIds } = data;
                if (!portfolioItemIds || portfolioItemIds.length === 0) {
                    logger.info(`[PortfolioWorker] No portfolioItemIds provided for value-portfolio-items job. Skipping.`);
                    return { success: true, processed: 0 };
                }
                const assets = await prisma.portfolioItem.findMany({
                    where: { tenantId, id: { in: portfolioItemIds } },
                    include: { category: true }
                });
                if (assets.length === 0) {
                    logger.info(`[PortfolioWorker] No assets found for provided IDs in value-portfolio-items job. Skipping.`);
                    return { success: true, processed: 0 };
                }
                return await generatePortfolioValuation({ ...job, data: { ...data, assets } });
            }
            case 'value-all-assets':
            case 'generate-portfolio-valuation': {
                const assets = await prisma.portfolioItem.findMany({
                    where: { tenantId: data.tenantId, category: { type: { in: ['Investments', 'Asset'] } } },
                    include: { category: true }
                });
                if (assets.length === 0) {
                    logger.info(`[PortfolioWorker] No investment assets found for tenant ${data.tenantId}. Skipping job.`);
                    return { success: true, processed: 0 };
                }
                return await generatePortfolioValuation({ ...job, data: { ...data, assets } });
            }
            case 'recalculate-portfolio-items': {
                const { tenantId, portfolioItemIds } = data;
                if (!portfolioItemIds || portfolioItemIds.length === 0) {
                    logger.info(`[PortfolioWorker] No portfolioItemIds provided for recalculate-portfolio-items job. Skipping.`);
                    return { success: true, processed: 0 };
                }

                logger.info(`[PortfolioWorker] Recalculating ${portfolioItemIds.length} portfolio items.`);
                
                const items = await prisma.portfolioItem.findMany({
                    where: { id: { in: portfolioItemIds }, tenantId },
                    include: { category: true, debtTerms: true }
                });

                // Group items by their processing type
                const itemsByType = items.reduce((acc, item) => {
                    let type = 'investments'; // default
                    if (item.category?.processingHint === 'SIMPLE_LIABILITY') type = 'simpleLiabilities';
                    else if (item.category?.processingHint === 'AMORTIZING_LOAN') type = 'amortizingLoans';
                    
                    if (!acc[type]) acc[type] = [];
                    acc[type].push(item);
                    return acc;
                }, {});

                // Dispatch batches to the correct processors
                const processingPromises = [];
                if (itemsByType.investments?.length > 0) {
                    processingPromises.push(generatePortfolioValuation({ ...job, data: { tenantId, assets: itemsByType.investments } }));
                }
                if (itemsByType.simpleLiabilities?.length > 0) {
                    processingPromises.push(simpleLiabilityProcessor({ ...job, data: { tenantId, debts: itemsByType.simpleLiabilities } }));
                }
                if (itemsByType.amortizingLoans?.length > 0) {
                    processingPromises.push(processAmortizingLoan({ ...job, data: { tenantId, debts: itemsByType.amortizingLoans } }));
                }

                await Promise.all(processingPromises);
                return { success: true, processed: items.length };
            }
            case 'revalue-all-tenants': {
                const startTime = Date.now();

                // Find all tenants that have at least one portfolio item
                const tenants = await prisma.tenant.findMany({
                    where: {
                        portfolioItems: { some: {} },
                    },
                    select: { id: true },
                });

                logger.info(`[NightlyRevaluation] Found ${tenants.length} tenants with portfolio items`);

                let enqueued = 0;
                let errors = 0;
                const queue = getPortfolioQueue();

                const today = new Date().toISOString().split('T')[0];

                for (const tenant of tenants) {
                    try {
                        // Use date-scoped jobIds to deduplicate with any staleness-triggered
                        // revaluation that may already be queued or running for this tenant.
                        const dedupePrefix = `nightly-revalue-${tenant.id}-${today}`;

                        // Enqueue valuation jobs for this tenant.
                        // NOTE: We intentionally skip `process-cash-holdings` here because
                        // cash holdings haven't changed (no new transactions). That job
                        // emits CASH_HOLDINGS_PROCESSED which cascades into a full analytics
                        // rebuild + a second valuation run — all unnecessary. The
                        // `value-all-assets` job already handles cash assets via its
                        // forward-fill logic in the valuation engine.
                        await queue.add('value-all-assets', { tenantId: tenant.id }, { jobId: `${dedupePrefix}-valuation` });
                        await queue.add('process-simple-liability', { tenantId: tenant.id }, { jobId: `${dedupePrefix}-liability` });
                        await queue.add('process-amortizing-loan', { tenantId: tenant.id }, { jobId: `${dedupePrefix}-amortizing` });

                        enqueued++;
                        logger.info(`[NightlyRevaluation] Enqueued revaluation jobs for tenant ${tenant.id}`);
                    } catch (error) {
                        errors++;
                        logger.error(`[NightlyRevaluation] Failed to enqueue for tenant ${tenant.id}:`, {
                            error: error.message,
                        });
                        Sentry.withScope((scope) => {
                            scope.setTag('worker', 'portfolioWorker');
                            scope.setTag('jobName', 'revalue-all-tenants');
                            scope.setExtra('tenantId', tenant.id);
                            Sentry.captureException(error);
                        });
                    }

                    // 1-second delay between tenants to avoid flooding the queue
                    if (tenants.indexOf(tenant) < tenants.length - 1) {
                        await new Promise((r) => setTimeout(r, 1000));
                    }
                }

                const duration = Date.now() - startTime;
                logger.info('[NightlyRevaluation] Complete:', {
                    jobId: job.id,
                    totalTenants: tenants.length,
                    enqueued,
                    errors,
                    duration: `${duration}ms`,
                });
                return { success: true, totalTenants: tenants.length, enqueued, errors, duration };
            }
            default:
                logger.warn(`Unknown portfolio job name: ${name}`);
                break;
        }
    } catch (error) {
        logger.error(`Error processing portfolio job ${name} for job ${job.id}:`, {
            message: error.message,
            stack: error.stack,
            jobData: job.data,
        });
        throw error;
    }
};

const startPortfolioWorker = () => {
    logger.info('Starting Portfolio Worker...');
    logger.info({ redisConnection: !!getRedisConnection() }, 'Checking Redis connection before starting worker');
    const worker = new Worker(PORTFOLIO_QUEUE_NAME, processPortfolioJob, {
        connection: getRedisConnection(),
        concurrency: 5,
        // Long-running jobs (e.g. process-cash-holdings rebuilding 15+ years of data)
        // can exceed BullMQ's default 30s lock. 5 minutes covers the worst case;
        // BullMQ v5 auto-renews at lockDuration / 2 (every 150s).
        lockDuration: 300_000,  // 5 minutes
    });

    // Register the nightly revaluation job (4 AM UTC — after securityMaster at 3 AM refreshes prices)
    getPortfolioQueue().add(
        'revalue-all-tenants',
        {},
        {
            repeat: { pattern: '0 4 * * *' }, // Daily at 4 AM UTC
            jobId: 'nightly-portfolio-revaluation',
        }
    );
    logger.info('Registered nightly portfolio revaluation cron (4 AM UTC)');

    // Add event listeners for logging
    worker.on('completed', async (job, result) => {
      logger.info(`Portfolio job completed successfully`, { jobName: job.name, jobId: job.id, result });
      // Release the single-flight rebuild lock if this job was the
      // terminal step of a manual rebuild chain (full-portfolio's
      // `value-all-assets`, or single-asset's `value-portfolio-items`).
      // See `utils/rebuildLock.js`.
      await maybeReleaseRebuildLock(job);
    });

    worker.on('failed', (job, error) => {
      reportWorkerFailure({
        workerName: 'portfolioWorker',
        job,
        error,
        extra: { jobData: job?.data },
      });
    });

    // Return worker reference so index.js can close it before disconnecting Redis
    return worker;
};

module.exports = { startPortfolioWorker }; 