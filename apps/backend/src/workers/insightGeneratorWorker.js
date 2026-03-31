const Sentry = require('@sentry/node');
const { Worker } = require('bullmq');
const logger = require('../utils/logger');
const { getRedisConnection } = require('../utils/redis');
const { INSIGHT_QUEUE_NAME, getInsightQueue } = require('../queues/insightQueue');
const { generateInsights } = require('../services/insightService');
const prisma = require('../../prisma/prisma.js');

/**
 * Processes insight generation jobs.
 *
 * Two job types:
 * - generate-tenant-insights: Single tenant (on-demand trigger)
 * - generate-all-insights: Iterates all tenants with transactions (daily cron)
 */
const processInsightJob = async (job) => {
    const { name, data } = job;
    const startTime = Date.now();

    logger.info(`Starting insight job: ${name}`, { jobId: job.id, data });

    try {
        switch (name) {
            case 'generate-tenant-insights': {
                const { tenantId } = data;
                if (!tenantId) throw new Error('tenantId is required');

                const results = await generateInsights(tenantId);
                const duration = Date.now() - startTime;
                logger.info('Single-tenant insight generation complete:', {
                    jobId: job.id,
                    tenantId,
                    insightCount: results.length,
                    duration: `${duration}ms`,
                });
                return { success: true, insightCount: results.length, duration };
            }

            case 'generate-all-insights': {
                // Find all tenants that have at least one transaction
                const tenants = await prisma.tenant.findMany({
                    where: {
                        transactions: { some: {} },
                    },
                    select: { id: true },
                });

                logger.info(`Found ${tenants.length} tenants with transactions for insight generation`);

                let totalInsights = 0;
                let errors = 0;

                for (const tenant of tenants) {
                    try {
                        const results = await generateInsights(tenant.id);
                        totalInsights += results.length;
                        logger.info('Tenant insights generated:', {
                            tenantId: tenant.id,
                            insightCount: results.length,
                        });
                    } catch (error) {
                        errors++;
                        logger.error('Failed to generate insights for tenant:', {
                            tenantId: tenant.id,
                            error: error.message,
                        });
                        Sentry.withScope((scope) => {
                            scope.setTag('worker', 'insightGenerator');
                            scope.setExtra('tenantId', tenant.id);
                            Sentry.captureException(error);
                        });
                    }

                    // 1-second delay between tenants to avoid rate limiting
                    if (tenants.indexOf(tenant) < tenants.length - 1) {
                        await new Promise((r) => setTimeout(r, 1000));
                    }
                }

                const duration = Date.now() - startTime;
                logger.info('All-tenant insight generation complete:', {
                    jobId: job.id,
                    totalTenants: tenants.length,
                    totalInsights,
                    errors,
                    duration: `${duration}ms`,
                });
                return { success: true, totalTenants: tenants.length, totalInsights, errors, duration };
            }

            default:
                throw new Error(`Unknown insight job name: ${name}`);
        }
    } catch (error) {
        logger.error('Error processing insight job:', {
            jobId: job.id,
            name,
            error: error.message,
            stack: error.stack,
            duration: `${Date.now() - startTime}ms`,
        });
        throw error;
    }
};

const startInsightGeneratorWorker = () => {
    logger.info('Starting Insight Generator Worker...');

    const worker = new Worker(INSIGHT_QUEUE_NAME, processInsightJob, {
        connection: getRedisConnection(),
        concurrency: 1,
        lockDuration: 600000, // 10 minutes — LLM calls can be slow
    });

    // Register the daily repeatable job
    getInsightQueue().add(
        'generate-all-insights',
        {},
        {
            repeat: { pattern: '0 6 * * *' }, // Daily at 6 AM UTC
            jobId: 'daily-insight-generation',
        }
    );

    worker.on('completed', (job) => {
        logger.info('Insight job completed:', {
            jobId: job.id,
            name: job.name,
            result: job.returnvalue,
        });
    });

    worker.on('failed', (job, error) => {
        logger.error('Insight job failed:', {
            jobId: job.id,
            name: job.name,
            error: error.message,
            stack: error.stack,
        });
        Sentry.withScope((scope) => {
            scope.setTag('worker', 'insightGenerator');
            scope.setTag('jobName', job?.name);
            scope.setExtra('jobId', job?.id);
            scope.setExtra('attemptsMade', job?.attemptsMade);
            Sentry.captureException(error);
        });
    });

    // Return worker reference so index.js can close it before disconnecting Redis
    return worker;
};

module.exports = { startInsightGeneratorWorker };
