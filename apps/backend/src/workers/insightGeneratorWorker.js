const Sentry = require('@sentry/node');
const { Worker } = require('bullmq');
const logger = require('../utils/logger');
const { getRedisConnection } = require('../utils/redis');
const { INSIGHT_QUEUE_NAME, getInsightQueue } = require('../queues/insightQueue');
const { generateTieredInsights, generateAllDueTiers, generateInsights } = require('../services/insightService');
const prisma = require('../../prisma/prisma.js');
const { reportWorkerFailure } = require('../utils/workerFailureReporter');

/**
 * Processes insight generation jobs across 5 tiers.
 *
 * Job types:
 * - generate-daily-pulse:         Daily anomaly detection (Flash model, 6 AM UTC)
 * - generate-monthly-review:      Monthly health check (Pro model, 2nd of month)
 * - generate-quarterly-deep-dive: Quarterly trend analysis (Pro model, after quarter close)
 * - generate-annual-report:       Annual comprehensive review (Pro model, Jan 3)
 * - generate-portfolio-intel:     Portfolio fundamentals analysis (Pro model, weekly Monday)
 * - generate-tenant-insights:     On-demand single-tier trigger for one tenant
 * - generate-all-insights:        Daily cron: runs daily pulse + checks if other tiers are due
 *
 * Legacy compatibility:
 * - generate-tenant-insights without tier → defaults to DAILY
 */
const processInsightJob = async (job) => {
  const { name, data } = job;
  const startTime = Date.now();

  logger.info(`Starting insight job: ${name}`, { jobId: job.id, data });

  try {
    switch (name) {
      // ── On-demand single tenant trigger ──────────────────────────
      case 'generate-tenant-insights': {
        const { tenantId, tier, year, month, quarter, periodKey, force } = data;
        if (!tenantId) throw new Error('tenantId is required');

        // If tier specified, generate that specific tier
        if (tier) {
          const result = await generateTieredInsights(tenantId, tier, {
            year, month, quarter, periodKey, force,
          });
          const duration = Date.now() - startTime;
          logger.info('Single-tenant tiered insight generation complete:', {
            jobId: job.id, tenantId, tier,
            insightCount: result.insights?.length || 0,
            skipped: result.skipped || false,
            duration: `${duration}ms`,
          });
          return { success: true, ...result, duration };
        }

        // Legacy: no tier specified → run daily pulse
        const result = await generateInsights(tenantId);
        const duration = Date.now() - startTime;
        return { success: true, insightCount: result.insights?.length || 0, duration };
      }

      // ── Daily cron: daily pulse + check other due tiers ──────────
      case 'generate-all-insights':
      case 'generate-daily-pulse': {
        const tenants = await prisma.tenant.findMany({
          where: { transactions: { some: {} } },
          select: { id: true },
        });

        logger.info(`Found ${tenants.length} tenants for insight generation (${name})`);

        let totalInsights = 0;
        let errors = 0;
        const tierResults = {};

        for (const tenant of tenants) {
          try {
            // For the main daily cron, check all due tiers
            if (name === 'generate-all-insights') {
              const results = await generateAllDueTiers(tenant.id);
              for (const [tier, result] of Object.entries(results)) {
                if (!tierResults[tier]) tierResults[tier] = { generated: 0, skipped: 0 };
                if (result.skipped) {
                  tierResults[tier].skipped++;
                } else {
                  tierResults[tier].generated++;
                  totalInsights += result.insights?.length || 0;
                }
              }
            } else {
              // Just daily pulse
              const result = await generateTieredInsights(tenant.id, 'DAILY');
              if (!result.skipped) {
                totalInsights += result.insights?.length || 0;
              }
            }
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
          jobId: job.id, name,
          totalTenants: tenants.length,
          totalInsights,
          errors,
          tierResults,
          duration: `${duration}ms`,
        });
        return { success: true, totalTenants: tenants.length, totalInsights, errors, tierResults, duration };
      }

      // ── Portfolio intelligence (weekly Monday) ────────────────────
      case 'generate-portfolio-intel': {
        const tenants = await prisma.tenant.findMany({
          where: {
            portfolioItems: {
              some: {
                quantity: { gt: 0 },
                ticker: { not: null },
              },
            },
          },
          select: { id: true },
        });

        logger.info(`Found ${tenants.length} tenants with equity holdings for portfolio intelligence`);

        let totalInsights = 0;
        let errors = 0;

        for (const tenant of tenants) {
          try {
            const result = await generateTieredInsights(tenant.id, 'PORTFOLIO');
            if (!result.skipped) {
              totalInsights += result.insights?.length || 0;
            }
          } catch (error) {
            errors++;
            logger.error('Failed to generate portfolio insights:', {
              tenantId: tenant.id,
              error: error.message,
            });
            Sentry.withScope((scope) => {
              scope.setTag('worker', 'insightGenerator');
              scope.setTag('tier', 'PORTFOLIO');
              scope.setExtra('tenantId', tenant.id);
              Sentry.captureException(error);
            });
          }

          if (tenants.indexOf(tenant) < tenants.length - 1) {
            await new Promise((r) => setTimeout(r, 1000));
          }
        }

        const duration = Date.now() - startTime;
        logger.info('Portfolio intelligence generation complete:', {
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
  logger.info('Starting Insight Generator Worker (v1 — tiered architecture)...');

  const worker = new Worker(INSIGHT_QUEUE_NAME, processInsightJob, {
    connection: getRedisConnection(),
    concurrency: 1,
    lockDuration: 600000, // 10 minutes — LLM calls can be slow
  });

  const queue = getInsightQueue();

  // ── Cron Jobs ────────────────────────────────────────────────────
  // Daily: 6 AM UTC — runs daily pulse + checks monthly/quarterly/annual triggers
  queue.add(
    'generate-all-insights',
    {},
    {
      repeat: { pattern: '0 6 * * *' },
      jobId: 'daily-insight-generation',
    }
  );

  // Portfolio Intelligence: Monday 5 AM UTC (after SecurityMaster refreshes at 3 AM)
  queue.add(
    'generate-portfolio-intel',
    {},
    {
      repeat: { pattern: '0 5 * * 1' },
      jobId: 'weekly-portfolio-intel',
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
    reportWorkerFailure({
      workerName: 'insightGenerator',
      job,
      error,
      extra: {
        tier: job?.data?.tier,
        periodKey: job?.data?.periodKey,
      },
    });
  });

  return worker;
};

module.exports = { startInsightGeneratorWorker };
