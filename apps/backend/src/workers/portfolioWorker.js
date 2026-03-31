const Sentry = require('@sentry/node');
const { Worker } = require('bullmq');
const logger = require('../utils/logger');
const { getRedisConnection } = require('../utils/redis');
const { PORTFOLIO_QUEUE_NAME } = require('../queues/portfolioQueue');
const prisma = require('../../prisma/prisma');

const recalculatePortfolioItem = require('./portfolio-handlers/recalculate-portfolio-item');
const processPortfolioChanges = require('./portfolio-handlers/process-portfolio-changes');
const simpleLiabilityProcessor = require('./portfolio-handlers/simple-liability-processor');
const processAmortizingLoan = require('./portfolio-handlers/amortizing-loan-processor');
const generatePortfolioValuation = require('./portfolio-handlers/valuation/index.js');
const { processCashHoldings } = require('./portfolio-handlers/cash-processor');

const processPortfolioJob = async (job) => {
    const { name, data } = job;
    logger.info(`Processing portfolio job: ${name}`, { data });

    try {
        switch (name) {
            case 'process-portfolio-changes':
                return await processPortfolioChanges(job);
            
            case 'process-cash-holdings': {
                const { tenantId, scope, originalScope, portfolioItemIds } = data;
                // Merge originalScope and portfolioItemIds into scope so the cash processor
                // can include them in the CASH_HOLDINGS_PROCESSED event it emits, which
                // allows the event scheduler to correctly trigger scoped analytics downstream.
                const enrichedScope = {
                    ...scope,
                    ...(originalScope !== undefined && { originalScope }),
                    ...(portfolioItemIds !== undefined && { portfolioItemIds }),
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

    // Add event listeners for logging
    worker.on('completed', (job, result) => {
      logger.info(`Portfolio job completed successfully`, { jobName: job.name, jobId: job.id, result });
    });

    worker.on('failed', (job, error) => {
      logger.error(`Portfolio job failed`, { jobName: job.name, jobId: job.id, error: error.message });
      Sentry.withScope((scope) => {
        scope.setTag('worker', 'portfolioWorker');
        scope.setTag('jobName', job?.name);
        scope.setExtra('jobId', job?.id);
        scope.setExtra('tenantId', job?.data?.tenantId);
        scope.setExtra('jobData', job?.data);
        scope.setExtra('attemptsMade', job?.attemptsMade);
        Sentry.captureException(error);
      });
    });

    // Return worker reference so index.js can close it before disconnecting Redis
    return worker;
};

module.exports = { startPortfolioWorker }; 