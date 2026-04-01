const { Decimal } = require('@prisma/client/runtime/library');
const logger = require('../../../../utils/logger');
const prisma = require('../../../../../prisma/prisma.js');
const { getHistoricalStockPrice } = require('../../../../services/stockService');

/**
 * Pricing strategy for API_FUND (ETFs, mutual funds).
 * Mirrors API_STOCK logic with a graceful fallback to manual values
 * for existing Funds items that may lack resolvable tickers.
 */
const MAX_CONSECUTIVE_API_FAILURES = 7;

const getPrice = async (portfolioItem, targetDate, priceCaches) => {
    const targetDateStr = targetDate.toISOString().split('T')[0];
    const { dbPriceMap, manualValueMap, forwardPriceCache } = priceCaches;
    const MAX_PRICE_LOOKBACK_DAYS = 7;

    // --- Stage 1: Check Caches for Exact Date ---
    if (forwardPriceCache.has(targetDateStr)) {
        return forwardPriceCache.get(targetDateStr);
    }
    if (dbPriceMap.has(targetDateStr)) {
        const dbPrice = dbPriceMap.get(targetDateStr);
        if (dbPrice.noData) return null;
        return { price: dbPrice.price, source: 'DB:AssetPrice' };
    }

    // --- Stage 2: Live API Call (skip for manually-tracked items without real tickers) ---
    // When source is 'MANUAL', the symbol is a fallback composite key (e.g., "Funds:PIC 33/60"),
    // not a real ticker — calling Twelve Data would always fail. Skip straight to Stage 3/4.
    // Also short-circuit after N consecutive API failures (likely an invalid ticker).
    const apiSkipped = portfolioItem.source === 'MANUAL'
        || (priceCaches._consecutiveApiFailures || 0) >= MAX_CONSECUTIVE_API_FAILURES;

    if (!apiSkipped) {
        const priceData = await getHistoricalStockPrice(portfolioItem.symbol, targetDate, { exchange: portfolioItem.exchange });
        if (priceData) {
            const upsertWhere = {
                symbol_assetType_day_currency_exchange: {
                    symbol: portfolioItem.symbol,
                    assetType: 'API_FUND',
                    day: targetDate,
                    currency: portfolioItem.currency || '',
                    exchange: portfolioItem.exchange || '',
                },
            };
            const priceRow = {
                symbol: portfolioItem.symbol,
                assetType: 'API_FUND',
                day: targetDate,
                price: priceData.price,
                currency: portfolioItem.currency,
                exchange: portfolioItem.exchange || '',
            };
            const savedPrice = await prisma.assetPrice.upsert({
                where: upsertWhere,
                create: priceRow,
                update: { price: priceData.price, noData: false },
            });
            dbPriceMap.set(targetDateStr, savedPrice);
            priceCaches._consecutiveApiFailures = 0; // Reset on success
            return { price: priceData.price, source: priceData.source };
        }

        // Track consecutive failures
        priceCaches._consecutiveApiFailures = (priceCaches._consecutiveApiFailures || 0) + 1;
        if (priceCaches._consecutiveApiFailures === MAX_CONSECUTIVE_API_FAILURES) {
            logger.warn(`[API_FUND] ${MAX_CONSECUTIVE_API_FAILURES} consecutive API failures for ${portfolioItem.symbol} — skipping further API calls for this run.`);
        }

        // Save a noData sentinel so we don't call the API again for this date on
        // future valuation runs (matching API_STOCK behaviour). Without this,
        // holiday/weekend dates keep incrementing _consecutiveApiFailures across
        // runs until the counter reaches MAX_CONSECUTIVE_API_FAILURES and blocks
        // ALL subsequent API calls — including valid trading days.
        try {
            await prisma.assetPrice.upsert({
                where: {
                    symbol_assetType_day_currency_exchange: {
                        symbol: portfolioItem.symbol,
                        assetType: 'API_FUND',
                        day: targetDate,
                        currency: portfolioItem.currency || '',
                        exchange: portfolioItem.exchange || '',
                    },
                },
                create: {
                    symbol: portfolioItem.symbol,
                    assetType: 'API_FUND',
                    day: targetDate,
                    price: new Decimal(0),
                    currency: portfolioItem.currency || '',
                    exchange: portfolioItem.exchange || '',
                    noData: true,
                },
                update: { noData: true },
            });
        } catch (err) {
            logger.warn(`[API_FUND] Failed to save no-data sentinel for ${portfolioItem.symbol} on ${targetDateStr}: ${err.message}`);
        }
        dbPriceMap.set(targetDateStr, { noData: true });
    }

    // --- Stage 3: Look-Back on Pre-Fetched DB Data ---
    for (let i = 1; i <= MAX_PRICE_LOOKBACK_DAYS; i++) {
        const priorDate = new Date(targetDate);
        priorDate.setDate(priorDate.getDate() - i);
        const priorDateStr = priorDate.toISOString().split('T')[0];

        if (dbPriceMap.has(priorDateStr)) {
            const record = dbPriceMap.get(priorDateStr);
            if (record.noData) continue; // skip no-data sentinels in lookback
            const lastKnownPrice = { price: record.price, source: 'DB:AssetPrice:ForwardFill' };
            forwardPriceCache.set(targetDateStr, lastKnownPrice);
            return lastKnownPrice;
        }
    }

    // --- Stage 4: Graceful Fallback to Manual Values ---
    // For existing Funds items that were MANUAL and may lack an API-resolvable ticker.
    // Uses unlimited lookback (matching MANUAL.js strategy) — not limited to 7 days.
    if (manualValueMap.size > 0) {
        // Exact date match
        if (manualValueMap.has(targetDateStr)) {
            const mv = manualValueMap.get(targetDateStr);
            return { price: mv.value, source: 'ManualValue:ExactDate' };
        }

        // Unlimited lookback — find most recent manual value before target date
        const sortedDates = Array.from(manualValueMap.keys())
            .sort((a, b) => new Date(b) - new Date(a)); // newest first
        for (const dateStr of sortedDates) {
            if (new Date(dateStr) <= targetDate) {
                const result = { price: manualValueMap.get(dateStr).value, source: 'ManualValue:ForwardFill' };
                forwardPriceCache.set(targetDateStr, result);
                return result;
            }
        }
    }

    return null;
};

module.exports = { getPrice };
