const logger = require('../utils/logger');
const { getLatestStockPrice, STOCK_PROVIDER } = require('./stockService');
const { getLatestCryptoPrice } = require('./cryptoService');
const prisma = require('../../prisma/prisma.js');

/**
 * Fetches the latest price for a given asset symbol from the most appropriate source.
 * This is intended for real-time or near-real-time price lookups.
 *
 * @param {string} symbol The asset's ticker or symbol.
 * @param {string} assetType The type of asset (e.g., 'Equity', 'Crypto').
 * @returns {Promise<{price: number, source: string}|null>} The price and its source, or null if not found.
 */
async function getLatestPrice(symbol, assetType, currency, { exchange } = {}) {
  logger.info(`[PriceService] Fetching latest price for ${symbol} (${assetType})${exchange ? ` on ${exchange}` : ''}`);

  let priceData;

  // 1. Attempt to fetch from the live API first based on the processing hint.
  if (assetType === 'API_STOCK' || assetType === 'API_FUND') {
    const price = await getLatestStockPrice(symbol, { exchange });
    if (price) {
      priceData = { price, source: `API:${STOCK_PROVIDER === 'TWELVE_DATA' ? 'TwelveData' : 'AlphaVantage'}` };
    }
  } else if (assetType === 'API_CRYPTO') {
    const price = await getLatestCryptoPrice(symbol, currency);
    if (price) {
      priceData = { price, source: 'API:TwelveData' };
    }
  }

  // If we got a price from an API, we can return it immediately.
  if (priceData) {
    logger.info(`[PriceService] Live price found for ${symbol}: ${priceData.price} from ${priceData.source}`);
    // We could add logic here to cache this response in Redis if needed later.
    return priceData;
  }

  // 2. If API fails or for non-API assets, fall back to the last known price in our DB.
  logger.warn(`[PriceService] No live API price for ${symbol}. Falling back to DB.`);

  const lastDbPrice = await prisma.assetPrice.findFirst({
    where: {
      symbol,
      assetType: assetType,
      ...(exchange ? { exchange } : {}),
    },
    orderBy: {
      day: 'desc',
    },
  });

  if (lastDbPrice) {
    logger.info(`[PriceService] Found last known DB price for ${symbol}: ${lastDbPrice.price}`);
    return { price: lastDbPrice.price.toNumber(), source: 'DB:AssetPrice' };
  }
  
  logger.error(`[PriceService] Could not find any price for ${symbol} from any source.`);
  return null;
}

module.exports = {
  getLatestPrice,
}; 