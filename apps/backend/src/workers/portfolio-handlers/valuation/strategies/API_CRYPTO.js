const { Decimal } = require('@prisma/client/runtime/library');
const logger = require('../../../../utils/logger');
const prisma = require('../../../../../prisma/prisma.js');
const { getHistoricalCryptoPrice } = require('../../../../services/cryptoService');

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
        // noData sentinel: we already confirmed TwelveData has nothing for this date.
        // Skip the API call — the caller's lastKnownPrice forward-fill handles the value.
        if (dbRecord.noData) return null;
        return { price: dbRecord.price, source: 'DB:AssetPrice' };
    }

    // --- Stage 2: Live API Call ---
    const currency = portfolioItem.assetCurrency || portfolioItem.currency || 'USD';
    const priceData = await getHistoricalCryptoPrice(portfolioItem.symbol, targetDate, currency);
    if (priceData) {
        // Save the newly fetched price to the DB for future use
        const upsertWhere = {
            symbol_assetType_day_currency_exchange: {
                symbol: portfolioItem.symbol,
                assetType: 'API_CRYPTO',
                day: targetDate,
                currency: portfolioItem.currency || '',
                exchange: '',
            },
        };
        const priceRow = {
            symbol: portfolioItem.symbol,
            assetType: 'API_CRYPTO',
            day: targetDate,
            price: priceData.price,
            currency: portfolioItem.currency,
        };
        const savedPrice = await prisma.assetPrice.upsert({
            where: upsertWhere,
            create: priceRow,
            update: { price: priceData.price, noData: false },
        });
        dbPriceMap.set(targetDateStr, savedPrice); // Add to cache for this run
        return { price: priceData.price, source: priceData.source };
    }

    // API returned nothing — save a no-data sentinel so we don't call the API
    // again for this date on future valuation runs.
    try {
        await prisma.assetPrice.upsert({
            where: {
                symbol_assetType_day_currency_exchange: {
                    symbol: portfolioItem.symbol,
                    assetType: 'API_CRYPTO',
                    day: targetDate,
                    currency: portfolioItem.currency || '',
                    exchange: '',
                },
            },
            create: {
                symbol: portfolioItem.symbol,
                assetType: 'API_CRYPTO',
                day: targetDate,
                price: new Decimal(0),
                currency: portfolioItem.currency || '',
                exchange: '',
                noData: true,
            },
            update: { noData: true },
        });
    } catch (err) {
        logger.warn(`[API_CRYPTO] Failed to save no-data sentinel for ${portfolioItem.symbol} on ${targetDateStr}: ${err.message}`);
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
