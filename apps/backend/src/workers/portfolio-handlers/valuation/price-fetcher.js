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
 * Creates a stateful, optimized price finder for a single portfolio item.
 * This pre-fetches all necessary data from the database to avoid N+1 queries in loops.
 *
 * @param {object} portfolioItem The PortfolioItem object, with its category included.
 * @returns {Promise<function(Date): Promise<{price: Decimal, source: string}|null>>} An async function that takes a date and returns price data.
 */
const createPriceFinder = async (portfolioItem) => {
    // --- 1. Pre-fetch all relevant data for this item ---
    const [dbPrices, manualValues] = await Promise.all([
        prisma.assetPrice.findMany({
            where: {
                symbol: portfolioItem.symbol,
                ...(portfolioItem.exchange ? { exchange: portfolioItem.exchange } : {}),
            }
        }),
        prisma.manualAssetValue.findMany({ where: { assetId: portfolioItem.id }, orderBy: { date: 'asc' } })
    ]);

    // --- 2. Store pre-fetched data in maps for efficient lookup ---
    const dbPriceMap = new Map(dbPrices.map(p => [p.day.toISOString().split('T')[0], p]));
    const manualValueMap = new Map(manualValues.map(mv => [mv.date.toISOString().split('T')[0], mv]));
    
    // A cache specifically for prices that have been carried forward to avoid redundant look-backs.
    const forwardPriceCache = new Map();
    
    const priceCaches = { dbPriceMap, manualValueMap, forwardPriceCache };

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

module.exports = { createPriceFinder }; 