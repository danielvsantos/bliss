const logger = require('../utils/logger');
const { getLatestStockPrice, STOCK_PROVIDER } = require('./stockService');
const { getLatestCryptoPrice } = require('./cryptoService');
const prisma = require('../../prisma/prisma.js');

// ── In-process live price cache ───────────────────────────────────────────────
// Protects TwelveData credits when multiple concurrent requests (e.g. two
// different query-key variants of /api/portfolio/items) arrive within the same
// short window. A 60-second TTL is short enough to feel "live" and long enough
// to collapse all requests that land in the same page-load burst.
//
// Key: `${symbol}::${assetType}::${currency||''}::${exchange||''}`
// Value: { price, source, cachedAt }
//
// The cache is intentionally in-process (not Redis) — prices are volatile and
// we never want a stale cached price to outlive the process restart that happens
// when we deploy new code.

const PRICE_CACHE_TTL_MS = 60 * 1_000; // 60 seconds
const _priceCache = new Map();

function _getCached(key) {
    const entry = _priceCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > PRICE_CACHE_TTL_MS) {
        _priceCache.delete(key);
        return null;
    }
    return entry;
}

function _setCache(key, priceData) {
    _priceCache.set(key, { ...priceData, cachedAt: Date.now() });
    // Evict entries older than 2× TTL to keep memory bounded.
    // Runs on every write but is O(1) amortized because the map is small.
    const horizon = Date.now() - PRICE_CACHE_TTL_MS * 2;
    for (const [k, v] of _priceCache.entries()) {
        if (v.cachedAt < horizon) _priceCache.delete(k);
    }
}

/**
 * Fetches the latest price for a given asset symbol from the most appropriate source.
 * This is intended for real-time or near-real-time price lookups.
 *
 * @param {string} symbol The asset's ticker or symbol.
 * @param {string} assetType The type of asset (e.g., 'Equity', 'Crypto').
 * @returns {Promise<{price: number, source: string}|null>} The price and its source, or null if not found.
 */
async function getLatestPrice(symbol, assetType, currency, { exchange } = {}) {
  const cacheKey = `${symbol}::${assetType}::${currency || ''}::${exchange || ''}`;

  // Fast path: serve from cache if fresh.
  const cached = _getCached(cacheKey);
  if (cached) {
      logger.info(`[PriceService] Cache hit for ${symbol} (${assetType}) — price: ${cached.price}`);
      return { price: cached.price, source: cached.source };
  }

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

  // If we got a price from an API, cache and return it.
  if (priceData) {
    logger.info(`[PriceService] Live price found for ${symbol}: ${priceData.price} from ${priceData.source}`);
    _setCache(cacheKey, priceData);
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

/** Clears the in-process price cache. Exported for test isolation only. */
function clearPriceCache() {
    _priceCache.clear();
}

module.exports = {
  getLatestPrice,
  clearPriceCache,
}; 