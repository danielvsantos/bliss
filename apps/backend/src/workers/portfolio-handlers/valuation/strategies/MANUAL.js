const { Decimal } = require('@prisma/client/runtime/library');
const logger = require('../../../../utils/logger');
const prisma = require('../../../../../prisma/prisma.js');

const getPrice = async (portfolioItem, targetDate, priceCaches) => {
    const targetDateStr = targetDate.toISOString().split('T')[0];
    const { manualValueMap, forwardPriceCache } = priceCaches;

    // Manual prices have absolute priority for items with the MANUAL hint.
    if (manualValueMap.has(targetDateStr)) {
        return { price: manualValueMap.get(targetDateStr).value, source: 'Manual' };
    }

    // Look back for a manual price
    const sortedManualValueDates = Array.from(manualValueMap.keys()).sort((a, b) => new Date(b) - new Date(a));
    for (const dateStr of sortedManualValueDates) {
        if (new Date(dateStr) <= targetDate) {
            const lastKnownPrice = { price: manualValueMap.get(dateStr).value, source: 'Manual:ForwardFill' };
            forwardPriceCache.set(targetDateStr, lastKnownPrice); // Cache for this run
            return lastKnownPrice;
        }
    }
    
    // If no manual price is found for a MANUAL item, we return null.
    // It should not fall back to any other pricing method.
    return null;
};

module.exports = { getPrice }; 