const prisma = require('../../../../prisma/prisma.js');
const logger = require('../../../utils/logger');
const { Decimal } = require('@prisma/client/runtime/library');
const { createPriceFinder } = require('./price-fetcher');
const { createIncrementalHoldingsCalculator } = require('./holdings-calculator');
const { getOrCreateCurrencyRate, getRatesForDateRange } = require('../../../services/currencyService');
const { calculateTotalInvested } = require('../../../utils/portfolioItemStateCalculator');


// Prisma Accelerate enforces a 10-second execution timeout per query (P6004).
// Assets with long histories (e.g. 2,600+ days) produce large arrays that exceed
// this limit in a single createMany call. Batching keeps each call well under it.
const BATCH_SIZE = 500;
async function batchCreateMany(model, data, options = {}) {
    for (let i = 0; i < data.length; i += BATCH_SIZE) {
        const batch = data.slice(i, i + BATCH_SIZE);
        await model.createMany({ data: batch, ...options });
    }
}

/**
 * Generates historical portfolio valuations for all assets of a tenant.
 * This is the new, optimized version that avoids N+1 query problems.
 *
 * @param {object} job The BullMQ job object.
 * @param {object} job.data Contains tenantId and a list of assets.
 */
const generatePortfolioValuation = async (job) => {
    const { tenantId, portfolioItemIds } = job.data;
    let { assets } = job.data;

    // If a list of assets isn't directly provided, fetch them based on IDs or get all for a full run.
    if (!assets) {
        const whereClause = {
            tenantId,
            category: { processingHint: { not: 'CASH' } },
        };
        // If specific IDs are provided, use them. Otherwise, it's a full run.
        if (portfolioItemIds && portfolioItemIds.length > 0) {
            whereClause.id = { in: portfolioItemIds };
        }
        
        assets = await prisma.portfolioItem.findMany({
            where: whereClause,
            include: { category: true },
        });
    }
    
    if (!assets || assets.length === 0) {
        logger.info(`--- No assets found to value for tenant ${tenantId}. Skipping valuation. ---`);
        return { success: true, snapshotsCreated: 0 };
    }

    logger.info(`--- Starting Portfolio Valuation for tenant ${tenantId} on ${assets.length} assets ---`);

    // Use a shared cache for currency rates for the duration of this job run
    const currencyRateCache = new Map();

    // Helper function to abstract rate fetching logic
    const getRateFromCache = async (date, from, to) => {
        const dateStr = date.toISOString().slice(0, 10);
        const cacheKey = `${dateStr}_${from}_${to}`;
        if (currencyRateCache.has(cacheKey)) {
            return currencyRateCache.get(cacheKey);
        }
        // Fallback to the single-fetch function if a rate is missing from the bulk fetch.
        // This maintains robustness in case of missing historical data.
        const rate = await getOrCreateCurrencyRate(date, from, to, currencyRateCache);
        currencyRateCache.set(cacheKey, rate);
        return rate;
    };

    // --- Start Change: Smart Grouped Currency Rate Pre-Fetching ---
    try {
        const currencyGroups = {};

        // Batch-fetch earliest transaction dates for all non-USD assets in a single query
        // (replaces N individual findFirst queries with one groupBy)
        const nonUsdAssets = assets.filter(a => a.currency !== 'USD');
        const nonUsdAssetIds = nonUsdAssets.map(a => a.id);

        let assetEarliestMap = new Map();
        if (nonUsdAssetIds.length > 0) {
            const earliestByAsset = await prisma.transaction.groupBy({
                by: ['portfolioItemId'],
                where: { portfolioItemId: { in: nonUsdAssetIds }, tenantId },
                _min: { transaction_date: true }
            });
            assetEarliestMap = new Map(
                earliestByAsset.map(row => [row.portfolioItemId, row._min.transaction_date])
            );
        }

        // Group assets by currency and apply pre-fetched earliest dates
        for (const asset of nonUsdAssets) {
            const currency = asset.currency;

            if (!currencyGroups[currency]) {
                currencyGroups[currency] = {
                    assets: [],
                    earliestDate: null,
                    latestDate: new Date() // Forward-fill to present
                };
            }

            currencyGroups[currency].assets.push(asset);

            const assetEarliest = assetEarliestMap.get(asset.id);
            if (assetEarliest) {
                if (!currencyGroups[currency].earliestDate || assetEarliest < currencyGroups[currency].earliestDate) {
                    currencyGroups[currency].earliestDate = assetEarliest;
                }
            }
        }

        // Pre-fetch rates for each currency group's actual date range
        for (const [currency, group] of Object.entries(currencyGroups)) {
            if (group.earliestDate) {
                const ratesMap = await getRatesForDateRange(group.earliestDate, group.latestDate, currency, 'USD');
                for (const [dateStr, rate] of ratesMap.entries()) {
                    const cacheKey = `${dateStr}_${currency}_USD`;
                    currencyRateCache.set(cacheKey, rate);
                }
                logger.info(`[Valuation] Pre-fetched ${ratesMap.size} currency rates for ${currency}-USD.`);
            }
        }
    } catch (error) {
        logger.error(`[Valuation] Failed to pre-fetch currency rates for tenant ${tenantId}.`, { error: error.message });
        // We don't re-throw, allowing valuation to proceed with on-demand fetching via the fallback.
    }
    // --- End Change ---

    // --- Start Change: Smart Deletion Logic ---
    const cashAssets = assets.filter(a => a.category.processingHint === 'CASH');
    const nonCashAssets = assets.filter(a => a.category.processingHint !== 'CASH');

    const cashAssetIds = cashAssets.map(a => a.id);
    const nonCashAssetIds = nonCashAssets.map(a => a.id);

    // For cash assets, ONLY delete the value history. The holdings are the source of truth from the analytics worker.
    if (cashAssetIds.length > 0) {
        await prisma.portfolioValueHistory.deleteMany({ where: { assetId: { in: cashAssetIds } } });
        logger.info(`[Valuation] Cleared value history for ${cashAssetIds.length} CASH assets.`);
    }

    // For non-cash assets, delete both holdings and history for a full, idempotent rebuild.
    if (nonCashAssetIds.length > 0) {
        await prisma.portfolioValueHistory.deleteMany({ where: { assetId: { in: nonCashAssetIds } } });
        await prisma.portfolioHolding.deleteMany({ where: { portfolioItemId: { in: nonCashAssetIds } } });
        logger.info(`[Valuation] Cleared holdings and value history for ${nonCashAssetIds.length} NON-CASH assets.`);
    }
    // --- End Change ---

    let totalSnapshotsCreated = 0;
    let totalHoldingsCreated = 0;

    // Process each asset one by one.
    for (let i = 0; i < assets.length; i++) {
        const asset = assets[i];
        try {
            logger.info(`[Valuation] Processing asset ${i + 1} of ${assets.length}: ${asset.symbol}`, { tenantId, assetId: asset.id });

            // --- New Logic for CASH assets with forward-filling ---
            if (asset.category.processingHint === 'CASH') {
                const cashHoldings = await prisma.portfolioHolding.findMany({
                    where: { portfolioItemId: asset.id },
                    orderBy: { date: 'asc' },
                });

                const valueHistoryToCreate = [];
                
                if (cashHoldings.length > 0) {
                    // Create a map of holdings by date for quick lookup
                    const holdingsMap = new Map();
                    cashHoldings.forEach(holding => {
                        const dateStr = holding.date.toISOString().split('T')[0];
                        holdingsMap.set(dateStr, holding);
                    });

                    // Get the date range from first holding to today
                    const startDate = new Date(cashHoldings[0].date);
                    const today = new Date();
                    today.setUTCHours(0, 0, 0, 0);
                    
                    // Forward-fill cash value history (consistent with investment asset logic)
                    let currentBalance = new Decimal(0);
                    let dayIterator = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
                    const endOfDayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

                    // Get all dates that have holdings for efficient checking
                    const holdingDates = new Set(cashHoldings.map(h => h.date.toISOString().split('T')[0]));

                    while (dayIterator <= endOfDayUTC) {
                        const currentDate = new Date(dayIterator);
                        const dateStr = currentDate.toISOString().split('T')[0];
                        
                        // Update balance if there's a holding record for this date
                        if (holdingsMap.has(dateStr)) {
                            currentBalance = holdingsMap.get(dateStr).totalValue;
                        }
                        
                        // Skip days with zero balance and no holdings (like investment assets do)
                        if (currentBalance.isZero() && !holdingDates.has(dateStr)) {
                            dayIterator.setUTCDate(dayIterator.getUTCDate() + 1);
                            continue;
                        }
                        
                        // Convert to USD
                        let valueInUSD = currentBalance;
                        if (asset.currency !== 'USD') {
                            const rate = await getRateFromCache(currentDate, asset.currency, 'USD');
                            if (rate) {
                                valueInUSD = currentBalance.times(rate);
                            }
                        }

                        valueHistoryToCreate.push({
                            assetId: asset.id,
                            date: currentDate,
                            nativeValue: currentBalance,
                            nativeCurrency: asset.currency,
                            valueInUSD: valueInUSD,
                            source: 'SYSTEM',
                        });
                        
                        // Advance to next day
                        dayIterator.setUTCDate(dayIterator.getUTCDate() + 1);
                    }

                    if (valueHistoryToCreate.length > 0) {
                        await batchCreateMany(prisma.portfolioValueHistory, valueHistoryToCreate, { skipDuplicates: true });
                        totalSnapshotsCreated += valueHistoryToCreate.length;
                        logger.info(`[Valuation] Created ${valueHistoryToCreate.length} history records for cash asset ${asset.symbol} (forward-filled to present)`);
                    }
                }
                // Skip the rest of the complex valuation logic for this asset
                continue;
            }

            // --- Optimization 1: Create pre-fetching calculators/finders ---
            const { getHoldings, getDatesWithTransactions, getTransactions } = await createIncrementalHoldingsCalculator(tenantId, asset, currencyRateCache);
            const { getPrice, getDatesWithKnownPrices } = await createPriceFinder(asset);
            
            // --- Refactored Step 2: Unified Daily Processing ---
            const transactionDates = getDatesWithTransactions();

            if (transactionDates.length === 0) {
                logger.info(`[Valuation] No transactions or known prices found for asset ${asset.symbol}. Skipping.`, { tenantId, assetId: asset.id });
                continue;
            }

            // --- REMOVED: Per-asset rate fetching block is no longer needed ---

            let valueHistoryToCreate = [];
            let holdingsToCreate = [];
            // NOTE: cost-basis fallback is an expected, non-error state for
            // pre-IPO / pre-listing holdings and MANUAL assets before the
            // first manual price entry. The occurrence is already persisted
            // on each `PortfolioValueHistory.source` row as
            // `COST_BASIS_FALLBACK`, so we no longer emit a summary log for
            // it — the old summary was being captured by Sentry's console
            // integration and polluting the issue stream.

            const startDate = new Date(transactionDates[0]);
            const lastTxDate = new Date(transactionDates[transactionDates.length - 1]);
            const today = new Date();
            today.setUTCHours(0, 0, 0, 0);

            const knownPriceDates = getDatesWithKnownPrices(); // Still need this for the MANUAL fallback logic

            // --- Unified Daily Processing Loop ---
            // --- Start Change: Use UTC date iteration to prevent DST issues ---
            let dayIterator = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));

            // Cap the loop at the last transaction date when the position is fully closed.
            // No history is needed for days after the asset was completely liquidated.
            const finalQuantity = getHoldings(lastTxDate).quantity;
            const effectiveEndDate = finalQuantity.isZero() ? lastTxDate : today;
            const endOfDayUTC = new Date(Date.UTC(effectiveEndDate.getUTCFullYear(), effectiveEndDate.getUTCMonth(), effectiveEndDate.getUTCDate()));

            logger.info(`[Valuation] Starting daily processing loop for ${asset.symbol} from ${dayIterator.toISOString().split('T')[0]} to ${endOfDayUTC.toISOString().split('T')[0]}`, { tenantId, assetId: asset.id });
            
            // For market-priced assets, forward-fill the last known price when the API returns
            // no data (public holidays, exchange closures, TwelveData gaps).
            const isBackfillable =
                asset.category.processingHint === 'API_STOCK' ||
                asset.category.processingHint === 'API_CRYPTO' ||
                (asset.category.processingHint === 'API_FUND' && asset.source !== 'MANUAL');
            let lastKnownPrice = null;

            let iterationCount = 0;
            while (dayIterator <= endOfDayUTC) {
                iterationCount++;
                const currentDate = new Date(dayIterator); // Use a non-mutated copy for processing
                const dateStr = currentDate.toISOString().slice(0, 10);
                
                // Get holdings for this date
                const { quantity, costBasis } = getHoldings(currentDate);
                
                // CRITICAL FIX: Always advance the date first to prevent infinite loops
                const previousDate = dayIterator.toISOString().split('T')[0];
                dayIterator.setUTCDate(dayIterator.getUTCDate() + 1);
                
                // Only log first few iterations for debugging
                if (iterationCount <= 5) {
                    logger.info(`[Valuation] Processing iteration ${iterationCount} for ${asset.symbol} on ${dateStr} (quantity: ${quantity.toString()})`, { 
                        tenantId, 
                        assetId: asset.id,
                        advancing: `${previousDate} → ${dayIterator.toISOString().split('T')[0]}`
                    });
                }
                
                // Skip processing if zero quantity and no transaction on this date
                if (quantity.isZero() && !transactionDates.includes(dateStr)) {
                    continue; // Now safe because date was already advanced
                }

                const priceData = await getPrice(currentDate);
                let totalValue = new Decimal(0);
                let priceSource = 'Unknown';

                if (priceData && priceData.price) {
                    if (isBackfillable) lastKnownPrice = priceData;
                    totalValue = quantity.times(priceData.price);
                    priceSource = priceData.source || 'Unknown';
                } else if (isBackfillable && lastKnownPrice && quantity.gt(0)) {
                    // Holiday / exchange closure / data gap: forward-fill from the last market price.
                    totalValue = quantity.times(lastKnownPrice.price);
                    priceSource = `${lastKnownPrice.source}:BACKFILLED`;
                } else if (isBackfillable && !lastKnownPrice && quantity.gt(0) && costBasis.gt(0)) {
                    // Pre-IPO / pre-listing: no market price has been seen yet.
                    // Carry the asset at cost basis until the first real market price arrives.
                    totalValue = costBasis;
                    priceSource = 'COST_BASIS_FALLBACK';
                } else if (
                    (asset.category.processingHint === 'MANUAL' ||
                     (asset.category.processingHint === 'API_FUND' && asset.source === 'MANUAL'))
                    && quantity.gt(0)
                ) {
                    const firstManualPriceDate = knownPriceDates.length > 0 ? new Date(knownPriceDates[0]) : null;

                    if (!firstManualPriceDate || currentDate < firstManualPriceDate) {
                        if (costBasis.gt(0)) {
                            totalValue = costBasis;
                            priceSource = 'COST_BASIS_FALLBACK';
                        }
                    } else {
                        logger.warn(`Could not find price for MANUAL asset ${asset.symbol} on ${dateStr}. A manual price exists, but not for this date or a prior one.`, { tenantId, assetId: asset.id });
                    }
                } else if (quantity.gt(0)) {
                    logger.warn(`Could not find price for ${asset.symbol} on event date ${currentDate.toISOString().split('T')[0]}. Total value will be 0.`, { tenantId, assetId: asset.id });
                }

                let valueInUSD = new Decimal(0);
                if (asset.currency === 'USD') {
                    valueInUSD = totalValue;
                } else if (totalValue.gt(0)) {
                    const rate = await getRateFromCache(currentDate, asset.currency, 'USD');
                    if (rate) {
                        valueInUSD = totalValue.times(rate);
                    } else {
                        logger.warn(`Could not get USD conversion rate for ${asset.currency} on ${dateStr}. Storing 0.`, { tenantId, assetId: asset.id });
                    }
                }

                valueHistoryToCreate.push({
                    assetId: asset.id,
                    date: currentDate,
                    nativeValue: totalValue,
                    nativeCurrency: asset.currency,
                    valueInUSD: valueInUSD,
                    source: priceSource,
                });

                holdingsToCreate.push({
                    portfolioItemId: asset.id,
                    date: currentDate,
                    quantity: quantity,
                    costBasis: costBasis,
                    totalValue: totalValue,
                });
            }

            if (holdingsToCreate.length > 0) {
                await batchCreateMany(prisma.portfolioHolding, holdingsToCreate, { skipDuplicates: true });
                totalHoldingsCreated += holdingsToCreate.length;
                logger.info(`[Valuation] Created ${holdingsToCreate.length} holding records for asset ${asset.symbol}`, { tenantId, assetId: asset.id });
            }

            if (valueHistoryToCreate.length > 0) {
                await batchCreateMany(prisma.portfolioValueHistory, valueHistoryToCreate, { skipDuplicates: true });
                totalSnapshotsCreated += valueHistoryToCreate.length;
                logger.info(`[Valuation] Created ${valueHistoryToCreate.length} history records for asset ${asset.symbol}`, { tenantId, assetId: asset.id });
            }

            // --- Final Step: Update the master PortfolioItem with the final calculated state ---
            const finalState = getHoldings(new Date()); // Get holdings as of today
            if (finalState) {
                // Find the last known value from the history we just built.
                const lastKnownValueRecord = [...valueHistoryToCreate].reverse().find(h => h.nativeValue.gt(0));
                let latestTotalValue = lastKnownValueRecord ? lastKnownValueRecord.nativeValue : new Decimal(0);
                
                // --- Start Change: Fix for zero-quantity assets ---
                // If the final quantity is zero, the market value must also be zero,
                // regardless of the last known historical value.
                if (finalState.quantity.isZero()) {
                    latestTotalValue = new Decimal(0);
                }
                // --- End Change ---
                
                // Calculate final USD values
                let latestTotalValueInUSD = new Decimal(0);
                if (asset.currency === 'USD') {
                    latestTotalValueInUSD = latestTotalValue;
                } else if (lastKnownValueRecord) {
                    const rate = await getRateFromCache(new Date(lastKnownValueRecord.date), asset.currency, 'USD');
                    if (rate) {
                        latestTotalValueInUSD = latestTotalValue.times(rate);
                    }
                }
                
                // Note: totalInvested is not calculated within the holdings calculator. We calculate it here.
                const allTransactions = getTransactions();
                const totalInvested = calculateTotalInvested(allTransactions);
                let totalInvestedInUSD = new Decimal(0);
                if (asset.currency === 'USD') {
                    totalInvestedInUSD = totalInvested;
                } else {
                    for (const tx of allTransactions) {
                        if (tx.debit && new Decimal(tx.debit).gt(0)) {
                            const rate = await getRateFromCache(new Date(tx.transaction_date), asset.currency, 'USD');
                            if (rate) {
                                totalInvestedInUSD = totalInvestedInUSD.plus(new Decimal(tx.debit).times(rate));
                            }
                        }
                    }
                }

                await prisma.portfolioItem.update({
                    where: { id: asset.id },
                    data: {
                        costBasis: finalState.costBasis,
                        realizedPnL: finalState.realizedPnl,
                        quantity: finalState.quantity,
                        currentValue: latestTotalValue,
                        totalInvested: totalInvested,
                        // New USD fields
                        costBasisInUSD: finalState.costBasisInUSD,
                        realizedPnLInUSD: finalState.realizedPnlInUSD,
                        currentValueInUSD: latestTotalValueInUSD,
                        totalInvestedInUSD: totalInvestedInUSD,
                    }
                });
                logger.info(`[Valuation] Updated final state for PortfolioItem ${asset.symbol}`, { tenantId, assetId: asset.id });
            }

        } catch (error) {
            logger.error(`Error processing valuation for asset ${asset.id}: ${error.message}`, {
                tenantId,
                assetId: asset.id,
                stack: error.stack,
            });
        }
    }

    logger.info(`--- Finished Portfolio Valuation for tenant ${tenantId}. Created ${totalHoldingsCreated} holding records and ${totalSnapshotsCreated} value history records. ---`);
    return { success: true, snapshotsCreated: totalSnapshotsCreated };
};


module.exports = generatePortfolioValuation;