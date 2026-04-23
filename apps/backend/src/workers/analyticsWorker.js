const Sentry = require('@sentry/node');
const { Worker } = require('bullmq');
const { Decimal } = require('@prisma/client/runtime/library');
const logger = require('../utils/logger');
const { getRedisConnection } = require('../utils/redis'); // Import redisConnection
const { ANALYTICS_QUEUE_NAME, getAnalyticsQueue } = require('../queues/analyticsQueue'); // Corrected import
const axios = require('axios');
const { getOrCreateCurrencyRate, getRatesForDateRange } = require('../services/currencyService');
const { getCategoryMaps } = require('../utils/categoryCache'); // Import category cache
const { enqueueEvent } = require('../queues/eventsQueue'); // Corrected import path
const { reportWorkerFailure } = require('../utils/workerFailureReporter');

const prisma = require('../../prisma/prisma.js');

const CURRENCYLAYER_API_KEY = process.env.CURRENCYLAYER_API_KEY;
const CURRENCYLAYER_BASE_URL = "https://api.currencylayer.com/historical";

// --- Currency Rate Helpers ---

async function fetchHistoricalRate(date, currencyFrom, currencyTo) {
  const url = `${CURRENCYLAYER_BASE_URL}?access_key=${CURRENCYLAYER_API_KEY}&date=${date}&source=${currencyFrom}&currencies=${currencyTo}`;
  try {
    const response = await axios.get(url);
    const data = response.data;
    if (!data.success || !data.quotes) return null;
    return data.quotes[`${currencyFrom}${currencyTo}`];
  } catch (e) {
    logger.error(`API error for ${currencyFrom}->${currencyTo} on ${date}: ${e.message}`);
    return null;
  }
}

// --- Enhanced Analytics Calculation Logic ---

async function calculateAnalytics(tenantId, scope, targetCurrencies) {
  logger.info('Starting analytics calculation:', { tenantId, scope, targetCurrencies });

  const BATCH_SIZE = 1000;
  const rateCache = {};
  const requiredRates = new Map();
  const analyticsMap = new Map();
  const tagAnalyticsMap = new Map();

  // Normalise scope: consolidated scopes use { earliestDate, filters },
  // while legacy/full-rebuild scopes may use flat { year, month, type, group, currency, country }.
  const filters = scope.filters || {};
  const scopeType     = filters.type     || (scope.type     ? [scope.type]     : null);
  const scopeGroup    = filters.group    || (scope.group    ? [scope.group]    : null);
  const scopeCurrency = filters.currency || (scope.currency ? [scope.currency] : null);
  const scopeCountry  = filters.country  || (scope.country  ? [scope.country]  : null);

  // Build where clause for transactions
  const whereClause = { tenantId };
  if (scope.earliestDate) {
    // Consolidated scope: filter from earliestDate onwards
    const earliest = new Date(scope.earliestDate);
    whereClause.transaction_date = { gte: earliest };
  } else {
    // Legacy flat scope
    if (scope.year) whereClause.year = scope.year;
    if (scope.month) whereClause.month = scope.month;
  }

  // Push filters down to the DB when possible to avoid scanning all transactions
  if (scopeCurrency && scopeCurrency.length > 0) {
    whereClause.currency = scopeCurrency.length === 1 ? scopeCurrency[0] : { in: scopeCurrency };
  }
  if (scopeType && scopeType.length > 0) {
    whereClause.category = {
      ...(whereClause.category || {}),
      type: scopeType.length === 1 ? scopeType[0] : { in: scopeType },
    };
  }
  if (scopeGroup && scopeGroup.length > 0) {
    whereClause.category = {
      ...(whereClause.category || {}),
      group: scopeGroup.length === 1 ? scopeGroup[0] : { in: scopeGroup },
    };
  }
  if (scopeCountry && scopeCountry.length > 0) {
    whereClause.account = {
      ...(whereClause.account || {}),
      countryId: scopeCountry.length === 1 ? scopeCountry[0] : { in: scopeCountry },
    };
  }

  // --- PASS 1: Date Range Discovery (Batched) ---
  logger.info('[AnalyticsWorker] Starting Pass 1: Date Range Discovery');
  let cursor = null;
  let transactionCount = 0;
  while (true) {
    const transactionsForDates = await prisma.transaction.findMany({
      take: BATCH_SIZE,
      ...(cursor && { skip: 1, cursor: { id: cursor } }),
      where: whereClause,
      select: {
        id: true,
        transaction_date: true,
        currency: true,
        account: { select: { countryId: true } },
        category: { select: { type: true, group: true } },
      },
      orderBy: { id: 'asc' },
    });

    if (transactionsForDates.length === 0) {
      break;
    }
    transactionCount += transactionsForDates.length;


    const filteredForDates = transactionsForDates.filter(txn => {
        if (scopeType     && !scopeType.includes(txn.category?.type))       return false;
        if (scopeGroup    && !scopeGroup.includes(txn.category?.group))     return false;
        if (scopeCurrency && !scopeCurrency.includes(txn.currency))         return false;
        if (scopeCountry  && !scopeCountry.includes(txn.account?.countryId)) return false;
        return true;
    });

    for (const targetCurrency of targetCurrencies) {
      for (const txn of filteredForDates) {
        if (txn.currency !== targetCurrency) {
          const key = `${txn.currency}->${targetCurrency}`;
          if (!requiredRates.has(key)) {
            requiredRates.set(key, { minDate: txn.transaction_date, maxDate: txn.transaction_date });
          } else {
            const dates = requiredRates.get(key);
            if (txn.transaction_date < dates.minDate) dates.minDate = txn.transaction_date;
            if (txn.transaction_date > dates.maxDate) dates.maxDate = txn.transaction_date;
          }
        }
      }
    }
    cursor = transactionsForDates[transactionsForDates.length - 1].id;
  }
  logger.info(`[AnalyticsWorker] Pass 1 complete. Scanned ${transactionCount} transactions.`);


  // --- Pre-fetch all required currency rates ---
  for (const [key, dates] of requiredRates.entries()) {
    const [currencyFrom, currencyTo] = key.split('->');
    logger.info(`[AnalyticsWorker] Pre-fetching rates for ${currencyFrom}->${currencyTo} from ${dates.minDate.toISOString().slice(0,10)} to ${dates.maxDate.toISOString().slice(0,10)}`);
    const ratesMap = await getRatesForDateRange(dates.minDate, dates.maxDate, currencyFrom, currencyTo);
    for (const [dateStr, rate] of ratesMap.entries()) {
      const cacheKey = `${dateStr}_${currencyFrom}_${currencyTo}`;
      rateCache[cacheKey] = rate;
    }
  }

  // --- PASS 2: Analytics Calculation (Batched) ---
  logger.info('[AnalyticsWorker] Starting Pass 2: Analytics Calculation');
  cursor = null;
  let processedCount = 0;
  while (true) {
    const transactions = await prisma.transaction.findMany({
      take: BATCH_SIZE,
      ...(cursor && { skip: 1, cursor: { id: cursor } }),
      where: whereClause,
      include: { account: true, category: true, tags: { select: { tagId: true } } },
      orderBy: { id: 'asc' },
    });

    if (transactions.length === 0) {
      break;
    }
    processedCount += transactions.length;
    logger.info(`[AnalyticsWorker] Processing batch of ${transactions.length}. Total processed: ${processedCount}/${transactionCount}`);
    
    const filteredTransactions = transactions.filter(txn => {
        if (scopeType     && !scopeType.includes(txn.category?.type))       return false;
        if (scopeGroup    && !scopeGroup.includes(txn.category?.group))     return false;
        if (scopeCurrency && !scopeCurrency.includes(txn.currency))         return false;
        if (scopeCountry  && !scopeCountry.includes(txn.account?.countryId)) return false;
        return true;
    });
    
    for (const targetCurrency of targetCurrencies) {
      for (const txn of filteredTransactions) {
          const currency = txn.currency;
          const account = txn.account;
          const category = txn.category;
          const credit = new Decimal(txn.credit || 0);
          const debit = new Decimal(txn.debit || 0);

          let convertedCredit = credit;
          let convertedDebit = debit;

          if (currency !== targetCurrency) {
              const dateStr = txn.transaction_date.toISOString().slice(0, 10);
              const cacheKey = `${dateStr}_${currency}_${targetCurrency}`;
              let rate = rateCache[cacheKey];
              
              if (!rate) {
                  logger.warn(`[AnalyticsWorker] Rate not found in pre-fetched cache for ${currency}->${targetCurrency} on ${dateStr}. Fetching on-demand.`);
                  rate = await getOrCreateCurrencyRate(txn.transaction_date, currency, targetCurrency, rateCache);
                  if (rate) {
                      rateCache[cacheKey] = rate;
                  }
              }

              if (!rate) {
                  logger.error(`[AnalyticsWorker] Could not find or fetch rate for ${currency}->${targetCurrency} on ${dateStr}. Value will not be converted.`);
                  continue;
              }
              convertedCredit = credit.times(rate);
              convertedDebit = debit.times(rate);
          }

          const country = account?.countryId || "Unknown";
          const type = category?.type || "Uncategorized";
          const group = category?.group || "Uncategorized";
          const year = txn.year;
          const month = txn.month;
          const key = `${year}-${month}-${targetCurrency}-${country}-${type}-${group}`;

          if (!analyticsMap.has(key)) {
            analyticsMap.set(key, {
              year, month, currency: targetCurrency, country, type, group,
              credit: new Decimal(0), debit: new Decimal(0), balance: new Decimal(0)
            });
          }
          const entry = analyticsMap.get(key);
          entry.credit = entry.credit.plus(convertedCredit);
          entry.debit = entry.debit.plus(convertedDebit);
          entry.balance = entry.balance.plus(convertedCredit.minus(convertedDebit));

          // --- Tag Analytics: aggregate per-tag per-category ---
          if (txn.tags && txn.tags.length > 0) {
            const categoryId = category?.id || 0;
            const categoryName = category?.name || "Uncategorized";
            for (const { tagId } of txn.tags) {
              const tagKey = `${tagId}-${year}-${month}-${targetCurrency}-${country}-${type}-${group}-${categoryId}`;
              if (!tagAnalyticsMap.has(tagKey)) {
                tagAnalyticsMap.set(tagKey, {
                  tagId, year, month, currency: targetCurrency, country, type, group,
                  categoryId, categoryName,
                  credit: new Decimal(0), debit: new Decimal(0), balance: new Decimal(0)
                });
              }
              const tagEntry = tagAnalyticsMap.get(tagKey);
              tagEntry.credit = tagEntry.credit.plus(convertedCredit);
              tagEntry.debit = tagEntry.debit.plus(convertedDebit);
              tagEntry.balance = tagEntry.balance.plus(convertedCredit.minus(convertedDebit));
            }
          }
      }
    }
    cursor = transactions[transactions.length - 1].id;
  }
  logger.info('[AnalyticsWorker] Finished Pass 2.');

  const results = Array.from(analyticsMap.values());
  const tagResults = Array.from(tagAnalyticsMap.values());

  logger.info('Analytics calculation completed:', {
    groupCount: results.length,
    tagGroupCount: tagResults.length,
    tenantId,
    scope
  });
  return { analytics: results, tagAnalytics: tagResults };
}

// Cash holdings processing has been moved to the dedicated cash-processor.js worker

// --- BullMQ Worker Setup ---
const processAnalyticsJob = async (job) => {
    const { name, data } = job;
    const { tenantId, scope, scopes } = data; // Added 'scopes'
    const startTime = Date.now();

    logger.info(`Starting analytics job: ${name}`, {
        jobId: job.id,
        tenantId,
        scope,
        scopes
    });

    try {
        // Fetch tenant's configured currencies once
        const tenantCurrencies = await prisma.tenantCurrency.findMany({
          where: { tenantId },
          select: { currencyId: true },
        });

        if (tenantCurrencies.length === 0) {
          logger.warn(`Tenant ${tenantId} has no currencies configured. Skipping analytics job.`);
          return { success: true, message: 'No currencies for tenant.' };
        }
        const targetCurrencies = tenantCurrencies.map(c => c.currencyId);

        let newAnalytics = [];
        let newTagAnalytics = [];

        // On a full rebuild, wipe all existing analytics for this tenant first.
        // Upsert-only would leave stale rows (e.g. tag analytics for tags that
        // were removed from transactions) since those rows are never visited.
        const isFullRebuildJob = (name === 'full-rebuild-analytics') ||
            (name === 'recalculate-analytics' && (!scope || Object.keys(scope).length === 0) && !scopes);

        if (isFullRebuildJob) {
            logger.info(`[AnalyticsWorker] Full rebuild: clearing existing analytics for tenant ${tenantId}`);
            await prisma.$transaction([
                prisma.analyticsCacheMonthly.deleteMany({ where: { tenantId } }),
                prisma.tagAnalyticsCacheMonthly.deleteMany({ where: { tenantId } }),
            ]);
            logger.info(`[AnalyticsWorker] Cleared analytics cache for tenant ${tenantId}`);
        }

        switch (name) {
            case 'scoped-update-analytics':
                if (scopes && scopes.length > 0) {
                    for (const singleScope of scopes) {
                        const { analytics, tagAnalytics } = await calculateAnalytics(tenantId, singleScope, targetCurrencies);
                        newAnalytics.push(...analytics);
                        newTagAnalytics.push(...tagAnalytics);
                    }
                    // De-duplicate results in case scopes overlapped
                    const uniqueKeys = new Set();
                    newAnalytics = newAnalytics.filter(entry => {
                        const key = `${entry.year}-${entry.month}-${entry.currency}-${entry.country}-${entry.type}-${entry.group}`;
                        if (uniqueKeys.has(key)) {
                            return false;
                        }
                        uniqueKeys.add(key);
                        return true;
                    });
                    const uniqueTagKeys = new Set();
                    newTagAnalytics = newTagAnalytics.filter(entry => {
                        const key = `${entry.tagId}-${entry.year}-${entry.month}-${entry.currency}-${entry.country}-${entry.type}-${entry.group}-${entry.categoryId}`;
                        if (uniqueTagKeys.has(key)) {
                            return false;
                        }
                        uniqueTagKeys.add(key);
                        return true;
                    });
                }
                break;

            case 'recalculate-analytics': // This is the broad job from imports
            default: {
                const { analytics, tagAnalytics } = await calculateAnalytics(tenantId, scope || {}, targetCurrencies);
                newAnalytics = analytics;
                newTagAnalytics = tagAnalytics;
                break;
            }
        }

        // Report progress
        await job.updateProgress(50);
        logger.info('Analytics calculated, starting database updates:', {
          jobId: job.id,
          updateCount: newAnalytics.length
        });

        // Write analytics cache in batches. Two modes:
        //
        //  - Full rebuild: the outer $transaction above has already wiped
        //    the tenant's existing rows, so each batch is a pure
        //    createMany(). We deliberately do NOT pass `skipDuplicates` —
        //    after the wipe there should be no conflicts, and a unique
        //    violation here indicates a concurrent rebuild that we want
        //    to surface (the single-flight lock introduced in Issue 3
        //    prevents this, but letting it throw is the correct default).
        //
        //  - Scoped: we can't wipe the whole tenant (we'd lose untouched
        //    periods/types/groups), and Prisma has no native bulk upsert.
        //    Instead, atomically replace exactly the composite keys we're
        //    rewriting via a keyed deleteMany + createMany inside a
        //    single $transaction.
        //
        // This replaces the prior upsert-per-row pattern, which
        // round-tripped once per analytics entry (500 RTs per batch) and
        // pushed Prisma Accelerate past its Worker resource limits (the
        // "Error 1102: Worker exceeded resource limits" Cloudflare
        // responses observed in production).
        const WRITE_BATCH_SIZE = 500;

        for (let i = 0; i < newAnalytics.length; i += WRITE_BATCH_SIZE) {
            const batch = newAnalytics.slice(i, i + WRITE_BATCH_SIZE);
            // Strip any extraneous in-memory fields (e.g. `totalDebt`)
            // and attach tenantId for createMany.
            // eslint-disable-next-line no-unused-vars
            const rows = batch.map(({ totalDebt, ...rest }) => ({ ...rest, tenantId }));

            if (isFullRebuildJob) {
                await prisma.analyticsCacheMonthly.createMany({ data: rows });
            } else {
                const keys = rows.map(r => ({
                    year: r.year,
                    month: r.month,
                    currency: r.currency,
                    country: r.country,
                    type: r.type,
                    group: r.group,
                }));
                await prisma.$transaction([
                    prisma.analyticsCacheMonthly.deleteMany({ where: { tenantId, OR: keys } }),
                    prisma.analyticsCacheMonthly.createMany({ data: rows }),
                ]);
            }
        }

        // --- Tag Analytics Cache Write ---
        // Same delete-then-createMany pattern, but keyed on the 9-column
        // composite unique constraint (adds tagId + categoryId).
        if (newTagAnalytics.length > 0) {
          for (let i = 0; i < newTagAnalytics.length; i += WRITE_BATCH_SIZE) {
              const batch = newTagAnalytics.slice(i, i + WRITE_BATCH_SIZE);
              const rows = batch.map(entry => ({
                  tagId: entry.tagId,
                  year: entry.year,
                  month: entry.month,
                  currency: entry.currency,
                  country: entry.country,
                  type: entry.type,
                  group: entry.group,
                  categoryId: entry.categoryId,
                  categoryName: entry.categoryName,
                  credit: entry.credit,
                  debit: entry.debit,
                  balance: entry.balance,
                  tenantId,
              }));

              if (isFullRebuildJob) {
                  await prisma.tagAnalyticsCacheMonthly.createMany({ data: rows });
              } else {
                  const keys = rows.map(r => ({
                      tagId: r.tagId,
                      year: r.year,
                      month: r.month,
                      currency: r.currency,
                      country: r.country,
                      type: r.type,
                      group: r.group,
                      categoryId: r.categoryId,
                  }));
                  await prisma.$transaction([
                      prisma.tagAnalyticsCacheMonthly.deleteMany({ where: { tenantId, OR: keys } }),
                      prisma.tagAnalyticsCacheMonthly.createMany({ data: rows }),
                  ]);
              }
          }
          logger.info('Tag analytics cache updated:', {
            jobId: job.id,
            totalTagEntries: newTagAnalytics.length
          });
        }

        const duration = Date.now() - startTime;
        logger.info('Analytics update completed:', {
          jobId: job.id,
          tenantId,
          scope,
          duration: `${duration}ms`,
          stats: {
            totalProcessed: newAnalytics.length,
            totalTagEntries: newTagAnalytics.length,
          }
        });

        // --- Final Step: Emit completion event ---
        // Cash holdings are now handled by dedicated cash-processor.js worker
        // Pass along portfolioItemIds if they exist, to enable scoped valuation.
        const allAffectedItemIds = data.portfolioItemIds || [];
        const isFullRebuild = isFullRebuildJob;

        await enqueueEvent('ANALYTICS_RECALCULATION_COMPLETE', {
            tenantId,
            isFullRebuild,
            // For a full rebuild, we send no IDs. For scoped runs, we send the affected IDs.
            ...(isFullRebuild ? {} : { portfolioItemIds: allAffectedItemIds }),
        });


        return {
          success: true,
          duration,
          stats: {
            totalProcessed: newAnalytics.length,
            totalTagEntries: newTagAnalytics.length,
          }
        };

    } catch (error) {
        logger.error('Error processing analytics update:', {
            jobId: job.id,
            error: error.message,
            stack: error.stack,
            duration: `${Date.now() - startTime}ms`
        });
        throw error;
    }
};

const startAnalyticsWorker = () => {
    logger.info(`Starting Analytics Worker...`);
    // The worker now processes jobs based on their name, not a single function.
    const worker = new Worker(ANALYTICS_QUEUE_NAME, processAnalyticsJob, {
        connection: getRedisConnection(),
        concurrency: 1,
        lockDuration: 300000, // 5 minutes
        removeOnComplete: {
            age: 24 * 3600,
            count: 1000
        },
        removeOnFail: {
            age: 7 * 24 * 3600
        }
    });

    // Worker event handlers
    worker.on('completed', (job) => {
      logger.info('Analytics job completed successfully:', {
        jobId: job.id,
        result: job.returnvalue
      });
    });

    worker.on('failed', (job, error) => {
      reportWorkerFailure({
        workerName: 'analyticsWorker',
        job,
        error,
        extra: { scope: job?.data?.scope, stack: error?.stack },
      });
    });

    // Return worker reference so index.js can close it before disconnecting Redis
    return worker;
};


module.exports = { startAnalyticsWorker, calculateAnalytics };