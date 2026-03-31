const logger = require('../utils/logger');
const twelveDataService = require('./twelveDataService');

/**
 * Fetches the historical closing price for a crypto symbol via TwelveData.
 * Constructs a crypto pair (e.g. BTC/EUR) from the symbol and currency.
 * @param {string} symbol The crypto symbol (e.g., 'BTC', 'ETH').
 * @param {Date} date The target date.
 * @param {string} [currency='USD'] The quote currency for the pair.
 * @returns {Promise<{price: Decimal, source: string}|null>}
 */
async function getHistoricalCryptoPrice(symbol, date, currency = 'USD') {
    const pair = `${symbol}/${currency}`;
    logger.info(`[CryptoService] Fetching historical price for ${pair} on ${date.toISOString().split('T')[0]}`);
    return twelveDataService.getHistoricalPrice(pair, date);
}

/**
 * Fetches the latest (real-time) price for a crypto symbol via TwelveData.
 * @param {string} symbol The crypto symbol (e.g., 'BTC').
 * @param {string} [currency='USD'] The quote currency for the pair.
 * @returns {Promise<number|null>}
 */
async function getLatestCryptoPrice(symbol, currency = 'USD') {
    const pair = `${symbol}/${currency}`;
    logger.info(`[CryptoService] Fetching latest price for ${pair}`);
    return twelveDataService.getLatestPrice(pair);
}

/**
 * Searches for crypto symbols using TwelveData's symbol_search.
 * Deduplicates pairs (BTC/USD, BTC/EUR → BTC) and returns unified results.
 * @param {string} query — Search term (e.g., 'BTC', 'Bitcoin', 'ETH')
 * @param {number} [limit=10] — Maximum results to return
 * @returns {Promise<Array<{symbol, name, exchange, country, currency, type, mic_code}>>}
 */
async function searchCrypto(query, limit = 10) {
    const results = await twelveDataService.searchSymbol(query);

    // Filter for crypto results and deduplicate by base symbol
    const seen = new Set();
    return results
        .filter(r => r.type && r.type.toLowerCase().includes('digital currency'))
        .filter(r => {
            const base = r.symbol.split('/')[0];
            if (seen.has(base)) return false;
            seen.add(base);
            return true;
        })
        .slice(0, limit)
        .map(r => ({
            symbol: r.symbol.split('/')[0],
            name: r.name,
            exchange: '',
            country: '',
            currency: '',  // Empty — determined by account, not by search result
            type: 'Cryptocurrency',
            mic_code: '',
        }));
}

module.exports = {
    getHistoricalCryptoPrice,
    getLatestCryptoPrice,
    searchCrypto,
};
