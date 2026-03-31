const axios = require('axios');
const logger = require('../utils/logger');
const { Decimal } = require('@prisma/client/runtime/library');
const twelveDataService = require('./twelveDataService');

const STOCK_PROVIDER = process.env.STOCK_PROVIDER || 'ALPHA_VANTAGE';
const ALPHA_VANTAGE_API_KEY = process.env.NEXT_PUBLIC_ALPHA_VANTAGE_API_KEY;
const AV_THROTTLE_MS = 60000 / 80; // ~857ms, to stay under 70 calls per minute

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetches the historical closing price for a stock symbol.
 * Delegates to Twelve Data or Alpha Vantage based on STOCK_PROVIDER env var.
 * @param {string} symbol The stock ticker symbol.
 * @param {Date} date The date for which to fetch the price.
 * @param {Object} [options] Optional parameters.
 * @param {string} [options.exchange] ISO-10383 MIC code for exchange disambiguation (e.g. 'XPAR').
 * @returns {Promise<{price: Decimal, source: string}|null>}
 */
async function getHistoricalStockPrice(symbol, date, { exchange } = {}) {
    if (STOCK_PROVIDER === 'TWELVE_DATA') {
        return twelveDataService.getHistoricalPrice(symbol, date, { micCode: exchange });
    }

    // --- Alpha Vantage (legacy) ---
    if (!ALPHA_VANTAGE_API_KEY) {
        logger.warn('[StockService] ALPHA_VANTAGE_API_KEY is not set. Skipping API call.');
        return null;
    }

    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&apikey=${ALPHA_VANTAGE_API_KEY}&outputsize=full`;

    await sleep(AV_THROTTLE_MS);
    logger.info(`[StockService] Calling Alpha Vantage API for ${symbol}`, { url });

    try {
        const response = await axios.get(url, { timeout: 10000 });
        const timeSeries = response.data['Time Series (Daily)'];

        if (!timeSeries) {
            if (response.data.Note) {
                 logger.warn(`[StockService] Alpha Vantage API limit likely reached for ${symbol}.`, { note: response.data.Note });
            } else {
                 logger.warn(`[StockService] Invalid or empty time series data from Alpha Vantage for ${symbol}.`, { responseData: response.data });
            }
            return null;
        }

        for (let i = 0; i < 4; i++) {
            const targetDate = new Date(date);
            targetDate.setDate(targetDate.getDate() - i);
            const formattedDate = targetDate.toISOString().split('T')[0];

            if (timeSeries[formattedDate]) {
                const closePrice = parseFloat(timeSeries[formattedDate]['4. close']);
                logger.info(`[StockService] Fetched price for ${symbol} on ${formattedDate}: ${closePrice}`);
                return { price: new Decimal(closePrice), source: 'API:AlphaVantage' };
            }
        }

        logger.warn(`[StockService] No data found for ${symbol} on or before ${date.toISOString().split('T')[0]}.`);
        return null;

    } catch (error) {
        if (axios.isCancel(error)) {
            logger.error(`[StockService] Alpha Vantage request timed out for ${symbol}.`);
        } else if (error.response && error.response.data && error.response.data.Note) {
             logger.warn(`[StockService] Alpha Vantage API limit likely reached for ${symbol}.`, { note: error.response.data.Note });
        } else {
            logger.error(`[StockService] Error fetching data from Alpha Vantage for ${symbol}`, { error: error.message });
        }
        return null;
    }
}

/**
 * Fetches the latest price for a stock symbol.
 * Delegates to Twelve Data or Alpha Vantage based on STOCK_PROVIDER env var.
 * @param {string} symbol The stock ticker symbol.
 * @param {Object} [options] Optional parameters.
 * @param {string} [options.exchange] ISO-10383 MIC code for exchange disambiguation (e.g. 'XPAR').
 * @returns {Promise<number|null>} The latest price or null if not found.
 */
async function getLatestStockPrice(symbol, { exchange } = {}) {
    if (STOCK_PROVIDER === 'TWELVE_DATA') {
        return twelveDataService.getLatestPrice(symbol, { micCode: exchange });
    }

    // --- Alpha Vantage (legacy) ---
    if (!ALPHA_VANTAGE_API_KEY) {
        logger.error('[StockService] FATAL: ALPHA_VANTAGE_API_KEY is not set. Cannot fetch stock prices.');
        return null;
    }

    logger.info(`[StockService] Fetching latest price for ${symbol}`);
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${ALPHA_VANTAGE_API_KEY}`;

    await sleep(AV_THROTTLE_MS);
    try {
        const response = await axios.get(url, { timeout: 10000 });
        const quote = response.data['Global Quote'];

        if (quote && quote['05. price']) {
            const price = parseFloat(quote['05. price']);
            logger.info(`[StockService] Latest price for ${symbol}: ${price}`);
            return price;
        } else if (response.data.Note) {
            logger.warn(`[StockService] Alpha Vantage API limit likely reached for ${symbol}.`, { note: response.data.Note });
            return null;
        } else {
            logger.warn(`[StockService] No latest price data found for ${symbol} in Alpha Vantage response.`, { response: response.data });
            return null;
        }
    } catch (error) {
        if (axios.isCancel(error)) {
            logger.error(`[StockService] Alpha Vantage request timed out for ${symbol}.`);
        } else if (error.response && error.response.data && error.response.data.Note) {
            logger.warn(`[StockService] Alpha Vantage API limit likely reached during request for ${symbol}.`, { note: error.response.data.Note });
        } else {
            logger.error(`[StockService] Error fetching latest price for ${symbol}: ${error.message}`, { status: error.response?.status, data: error.response?.data });
        }
        return null;
    }
}


module.exports = {
    getHistoricalStockPrice,
    getLatestStockPrice,
    STOCK_PROVIDER,
};
