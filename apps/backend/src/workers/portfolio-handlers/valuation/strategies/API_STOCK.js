const { Decimal } = require('@prisma/client/runtime/library');
const logger = require('../../../../utils/logger');
const prisma = require('../../../../../prisma/prisma.js');
const { getHistoricalStockPrice } = require('../../../../services/stockService');

const MAX_CONSECUTIVE_API_FAILURES = 7;

const getPrice = async (portfolioItem, targetDate, priceCaches) => {
    const targetDateStr = targetDate.toISOString().split('T')[0];
    const { dbPriceMap, forwardPriceCache } = priceCaches;
    const MAX_PRICE_LOOKBACK_DAYS = 7;

    // --- Stage 1: Check Caches for Exact Date ---
    if (forwardPriceCache.has(targetDateStr)) {
        return forwardPriceCache.get(targetDateStr);
    }
    if (dbPriceMap.has(targetDateStr)) {
        const dbRecord = dbPriceMap.get(targetDateStr);
        // noData sentinel: we already confirmed TwelveData has nothing for this date
        // (e.g. holiday, market closure). Skip the API call — the caller's lastKnownPrice
        // forward-fill will handle producing a value.
        if (dbRecord.noData) return null;
        return { price: dbRecord.price, source: 'DB:AssetPrice' };
    }

    // --- Stage 2: Live API Call ---
    // Short-circuit: if we've seen N consecutive API failures for this symbol,
    // the ticker is likely invalid (e.g., custom fund name). Skip the API to avoid
    // hundreds of wasted calls during a full valuation run.
    if ((priceCaches._consecutiveApiFailures || 0) >= MAX_CONSECUTIVE_API_FAILURES) {
        dbPriceMap.set(targetDateStr, { noData: true });
        return null;
    }

    const priceData = await getHistoricalStockPrice(portfolioItem.symbol, targetDate, { exchange: portfolioItem.exchange });
    if (priceData) {
        // Save the newly fetched price to the DB for future use
        const upsertWhere = {
            symbol_assetType_day_currency_exchange: {
                symbol: portfolioItem.symbol,
                assetType: 'API_STOCK',
                day: targetDate,
                currency: portfolioItem.currency || '',
                exchange: portfolioItem.exchange || '',
            },
        };
        const priceRow = {
            symbol: portfolioItem.symbol,
            assetType: 'API_STOCK',
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
        dbPriceMap.set(targetDateStr, savedPrice); // Add to cache for this run
        priceCaches._consecutiveApiFailures = 0; // Reset on success
        return { price: priceData.price, source: priceData.source };
    }

    // Track consecutive failures — after MAX_CONSECUTIVE_API_FAILURES, skip remaining API calls
    priceCaches._consecutiveApiFailures = (priceCaches._consecutiveApiFailures || 0) + 1;
    if (priceCaches._consecutiveApiFailures === MAX_CONSECUTIVE_API_FAILURES) {
        logger.warn(`[API_STOCK] ${MAX_CONSECUTIVE_API_FAILURES} consecutive API failures for ${portfolioItem.symbol} — skipping further API calls for this run.`);
    }

    // API returned nothing — save a no-data sentinel so we don't call the API
    // again for this date on future valuation runs.
    try {
        await prisma.assetPrice.upsert({
            where: {
                symbol_assetType_day_currency_exchange: {
                    symbol: portfolioItem.symbol,
                    assetType: 'API_STOCK',
                    day: targetDate,
                    currency: portfolioItem.currency || '',
                    exchange: portfolioItem.exchange || '',
                },
            },
            create: {
                symbol: portfolioItem.symbol,
                assetType: 'API_STOCK',
                day: targetDate,
                price: new Decimal(0),
                currency: portfolioItem.currency || '',
                exchange: portfolioItem.exchange || '',
                noData: true,
            },
            update: { noData: true },
        });
    } catch (err) {
        logger.warn(`[API_STOCK] Failed to save no-data sentinel for ${portfolioItem.symbol} on ${targetDateStr}: ${err.message}`);
    }
    dbPriceMap.set(targetDateStr, { noData: true });

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

    return null;
};

module.exports = { getPrice };
