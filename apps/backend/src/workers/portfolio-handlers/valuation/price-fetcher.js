const logger = require('../../../utils/logger');
const prisma = require('../../../../prisma/prisma.js');
const path = require('path');
const fs = require('fs');

// --- Strategy Loader ---
const strategies = {};
const strategiesDir = path.join(__dirname, 'strategies');

// Dynamically load all strategy files from the 'strategies' directory
fs.readdirSync(strategiesDir)
    .filter(file => file.endsWith('.js'))
    .forEach(file => {
        const strategyName = path.basename(file, '.js');
        strategies[strategyName] = require(path.join(strategiesDir, file));
    });
logger.info(`Loaded pricing strategies: ${Object.keys(strategies).join(', ')}`);


/**
 * eToro copy values (#143) of a Copy Trading holding, by day. The holding is
 * linked to the copies of its account's eToro connections whose copied
 * investor is its ticker (case-insensitive). When a copy of the same investor
 * was restarted, the newest copy wins a day both have.
 *
 * @returns {Promise<Map<string, { value: import('@prisma/client/runtime/library').Decimal, currency: string }>>}
 */
const loadCopyValueMap = async (portfolioItem) => {
    const map = new Map();
    if (!portfolioItem.accountId) return map;
    const copies = await prisma.etoroCopy.findMany({
        where: {
            tenantId: portfolioItem.tenantId,
            parentUsername: String(portfolioItem.symbol).trim().toLowerCase(),
            connection: { accountId: portfolioItem.accountId },
        },
        select: { id: true, startedAt: true, createdAt: true },
    });
    if (copies.length === 0) return map;
    const order = new Map(copies.map((c) => [c.id, (c.startedAt || c.createdAt).getTime()]));
    const values = await prisma.etoroCopyValue.findMany({
        where: { tenantId: portfolioItem.tenantId, copyId: { in: copies.map((c) => c.id) } },
        orderBy: { day: 'asc' },
    });
    const owner = new Map();
    for (const v of values) {
        const day = v.day.toISOString().split('T')[0];
        if (owner.has(day) && order.get(owner.get(day)) > order.get(v.copyId)) continue;
        owner.set(day, v.copyId);
        map.set(day, { value: v.value, currency: v.currency });
    }
    return map;
};

/**
 * Creates a stateful, optimized price finder for a single portfolio item.
 * This pre-fetches all necessary data from the database to avoid N+1 queries in loops.
 *
 * @param {object} portfolioItem The PortfolioItem object, with its category included.
 * @returns {Promise<function(Date): Promise<{price: Decimal, source: string}|null>>} An async function that takes a date and returns price data.
 */
const createPriceFinder = async (portfolioItem) => {
    const isCopyTrade = portfolioItem.category?.processingHint === 'COPY_TRADING';

    // --- 1. Pre-fetch all relevant data for this item ---
    // A Copy Trading holding's symbol is an eToro username, never a market
    // symbol, so it never reads AssetPrice.
    const [dbPrices, manualValues, copyValueMap] = await Promise.all([
        isCopyTrade ? [] : prisma.assetPrice.findMany({
            where: {
                symbol: portfolioItem.symbol,
                // Prices are stored per listing ('' = no MIC). A holding without an
                // exchange must not pick up another listing's rows, and one with an
                // exchange must not reuse bare-symbol rows (#134).
                exchange: portfolioItem.exchange || '',
            }
        }),
        prisma.manualAssetValue.findMany({ where: { assetId: portfolioItem.id }, orderBy: { date: 'asc' } }),
        isCopyTrade ? loadCopyValueMap(portfolioItem) : new Map(),
    ]);

    // --- 2. Store pre-fetched data in maps for efficient lookup ---
    const dbPriceMap = new Map(dbPrices.map(p => [p.day.toISOString().split('T')[0], p]));
    const manualValueMap = new Map(manualValues.map(mv => [mv.date.toISOString().split('T')[0], mv]));
    
    // A cache specifically for prices that have been carried forward to avoid redundant look-backs.
    const forwardPriceCache = new Map();
    
    const priceCaches = { dbPriceMap, manualValueMap, forwardPriceCache, copyValueMap };

    // --- 3. Create the functions to be returned ---
    const getPrice = async (targetDate) => {
        const hint = portfolioItem.category.processingHint;
        const strategy = strategies[hint];

        if (!strategy) {
            logger.warn(`No pricing strategy found for hint: '${hint}' on portfolio item: ${portfolioItem.symbol}`);
            return null;
        }

        try {
            return await strategy.getPrice(portfolioItem, targetDate, priceCaches);
        } catch (error) {
            logger.error(`Error executing pricing strategy '${hint}' for item ${portfolioItem.id}`, {
                message: error.message,
                stack: error.stack,
            });
            return null;
        }
    };

    // Manual and market price dates only: eToro copy values are totals, read
    // through getPrice (the MANUAL cost-basis fallback keys off these dates).
    const getDatesWithKnownPrices = () => {
        const dbDates = Array.from(dbPriceMap.keys());
        const manualDates = Array.from(manualValueMap.keys());
        // Use a Set to ensure uniqueness of dates from both sources
        return [...new Set([...dbDates, ...manualDates])].sort();
    };

    // --- 4. Return the object containing both functions ---
    return {
        getPrice,
        getDatesWithKnownPrices
    };
};

module.exports = { createPriceFinder, loadCopyValueMap }; 