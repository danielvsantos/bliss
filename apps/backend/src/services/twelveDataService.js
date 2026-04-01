const axios = require('axios');
const logger = require('../utils/logger');
const { Decimal } = require('@prisma/client/runtime/library');

const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;
const BASE_URL = 'https://api.twelvedata.com';

// Three independent rate-limit queues so import bursts, continuous valuation, and
// nightly fundamentals don't block each other. All share the 377 credits/minute Grow plan limit:
//   Import       (searchSymbol + getSymbolProfile): 150 calls/min → 1 slot / 400ms
//   Valuation    (getHistoricalPrice + getLatestPrice): 200 calls/min → 1 slot / 300ms
//   Fundamentals (getEarnings + getDividends, nightly only): ~30 calls/min → 1 slot / 2000ms
//   Combined worst-case (import + valuation): 350/min — safely below the 377 cap.
//   Fundamentals run overnight when import/valuation are idle.
const IMPORT_THROTTLE_MS = Math.ceil(60_000 / 70);          // ~857ms per import slot
const VALUATION_THROTTLE_MS = Math.ceil(60_000 / 300);      // ~200ms per valuation slot
const FUNDAMENTALS_THROTTLE_MS = Math.ceil(60_000 / 30);    // ~2000ms per fundamentals slot

/** Redact the apikey query param from URLs before logging. */
function sanitizeUrl(url) {
    return url.replace(/apikey=[^&]+/gi, 'apikey=***');
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Safely parse a numeric value from Twelve Data.
 * Returns null for null, undefined, empty strings, and NaN results.
 */
function safeParseFloat(value) {
    if (value == null || value === '') return null;
    const num = parseFloat(value);
    return Number.isNaN(num) ? null : num;
}

/**
 * Rate-limit slot acquirers — one per usage domain.
 *
 * Each caller reserves the NEXT available slot synchronously (before any
 * await), so concurrent callers always get staggered slots rather than
 * firing simultaneously. This is safe in Node's single-threaded event loop:
 * the synchronous portion of two concurrent calls never interleaves.
 *
 * acquireImportSlot        — used by searchSymbol() and getSymbolProfile()
 * acquireValuationSlot     — used by getHistoricalPrice() and getLatestPrice()
 * acquireFundamentalsSlot  — used by getEarnings() and getDividends() (nightly batch)
 */
let _importNextSlotTime = 0;
async function acquireImportSlot() {
    const now = Date.now();
    const wait = Math.max(0, _importNextSlotTime - now);
    _importNextSlotTime = Math.max(now, _importNextSlotTime) + IMPORT_THROTTLE_MS;
    if (wait > 0) await sleep(wait);
}

let _valuationNextSlotTime = 0;
async function acquireValuationSlot() {
    const now = Date.now();
    const wait = Math.max(0, _valuationNextSlotTime - now);
    _valuationNextSlotTime = Math.max(now, _valuationNextSlotTime) + VALUATION_THROTTLE_MS;
    if (wait > 0) await sleep(wait);
}

let _fundamentalsNextSlotTime = 0;
async function acquireFundamentalsSlot() {
    const now = Date.now();
    const wait = Math.max(0, _fundamentalsNextSlotTime - now);
    _fundamentalsNextSlotTime = Math.max(now, _fundamentalsNextSlotTime) + FUNDAMENTALS_THROTTLE_MS;
    if (wait > 0) await sleep(wait);
}

/**
 * Fetches the historical closing price for a symbol from Twelve Data.
 * Backtracks up to 3 days to find a valid price (weekends/holidays).
 * @param {string} symbol The ticker symbol (e.g. 'VWCE.DEX', 'AAPL').
 * @param {Date} date The target date.
 * @param {Object} [options] Optional parameters.
 * @param {string} [options.micCode] ISO-10383 MIC code for exchange disambiguation (e.g. 'XPAR', 'XETR').
 * @returns {Promise<{price: Decimal, source: string}|null>}
 */
async function getHistoricalPrice(symbol, date, { micCode } = {}) {
    if (!TWELVE_DATA_API_KEY) {
        logger.warn('[TwelveData] TWELVE_DATA_API_KEY is not set. Skipping API call.');
        return null;
    }

    // Request 4 days ending at target date to cover weekend backtrack
    const endDate = date.toISOString().split('T')[0];
    const startDate = new Date(date);
    startDate.setDate(startDate.getDate() - 3);
    const startStr = startDate.toISOString().split('T')[0];

    const url = `${BASE_URL}/time_series`;

    await acquireValuationSlot();
    logger.info(`[TwelveData] Fetching historical price for ${symbol}`, { startDate: startStr, endDate, micCode: micCode || 'none' });

    try {
        const response = await axios.get(url, {
            timeout: 10000,
            params: { symbol, interval: '1day', start_date: startStr, end_date: endDate, apikey: TWELVE_DATA_API_KEY, ...(micCode && { mic_code: micCode }) },
        });

        if (response.data.status === 'error') {
            // If the call failed WITH a mic_code, retry WITHOUT it. The mic_code
            // might not match TwelveData's internal exchange mapping for ETFs/funds
            // (e.g., mic_code "XNAS" for a fund that TwelveData indexes differently).
            if (micCode) {
                logger.info(`[TwelveData] Retrying ${symbol} without mic_code (was: ${micCode})`);
                await acquireValuationSlot();
                const retryResponse = await axios.get(url, {
                    timeout: 10000,
                    params: { symbol, interval: '1day', start_date: startStr, end_date: endDate, apikey: TWELVE_DATA_API_KEY },
                });

                if (retryResponse.data.status === 'error') {
                    logger.warn(`[TwelveData] API error for ${symbol} (retry without mic_code): ${retryResponse.data.message}`);
                    return null;
                }

                const retryValues = retryResponse.data.values;
                if (!retryValues || retryValues.length === 0) {
                    logger.warn(`[TwelveData] No time series data for ${symbol} around ${endDate} (retry without mic_code).`);
                    return null;
                }

                const retryPrice = parseFloat(retryValues[0].close);
                logger.info(`[TwelveData] Price for ${symbol} on ${retryValues[0].datetime}: ${retryPrice} (resolved without mic_code)`);
                return { price: new Decimal(retryPrice), source: 'API:TwelveData' };
            }

            logger.warn(`[TwelveData] API error for ${symbol}: ${response.data.message}`);
            return null;
        }

        const values = response.data.values;
        if (!values || values.length === 0) {
            logger.warn(`[TwelveData] No time series data for ${symbol} around ${endDate}.`);
            return null;
        }

        // values are sorted desc by date — first entry is the most recent
        const closePrice = parseFloat(values[0].close);
        logger.info(`[TwelveData] Price for ${symbol} on ${values[0].datetime}: ${closePrice}`);
        return { price: new Decimal(closePrice), source: 'API:TwelveData' };
    } catch (error) {
        logger.error(`[TwelveData] Error fetching historical price for ${symbol}`, { error: error.message });
        return null;
    }
}

/**
 * Fetches the latest (real-time) price for a symbol from Twelve Data.
 * @param {string} symbol The ticker symbol.
 * @param {Object} [options] Optional parameters.
 * @param {string} [options.micCode] ISO-10383 MIC code for exchange disambiguation (e.g. 'XPAR', 'XETR').
 * @param {boolean} [options.extended] If true, returns an object with additional quote data (52-week range, avg volume).
 * @returns {Promise<number|{close: number, week52High: number, week52Low: number, averageVolume: number}|null>}
 */
async function getLatestPrice(symbol, { micCode, extended } = {}) {
    if (!TWELVE_DATA_API_KEY) {
        logger.warn('[TwelveData] TWELVE_DATA_API_KEY is not set. Skipping API call.');
        return null;
    }

    const url = `${BASE_URL}/quote`;

    await acquireValuationSlot();
    logger.info(`[TwelveData] Fetching latest price for ${symbol}`);

    try {
        const response = await axios.get(url, {
            timeout: 10000,
            params: { symbol, apikey: TWELVE_DATA_API_KEY, ...(micCode && { mic_code: micCode }) },
        });

        if (response.data.status === 'error') {
            logger.warn(`[TwelveData] API error for ${symbol}: ${response.data.message}`);
            return null;
        }

        const price = parseFloat(response.data.close);
        if (isNaN(price)) {
            logger.warn(`[TwelveData] Invalid price in quote for ${symbol}.`, { data: response.data });
            return null;
        }

        logger.info(`[TwelveData] Latest price for ${symbol}: ${price}`);

        if (extended) {
            const w52 = response.data.fifty_two_week || {};
            return {
                close: price,
                currency: response.data.currency || null,
                week52High: w52.high ? parseFloat(w52.high) : null,
                week52Low: w52.low ? parseFloat(w52.low) : null,
                averageVolume: response.data.average_volume ? parseFloat(response.data.average_volume) : null,
            };
        }

        return price;
    } catch (error) {
        logger.error(`[TwelveData] Error fetching latest price for ${symbol}`, { error: error.message });
        return null;
    }
}

/**
 * Searches for symbols matching a query string.
 * @param {string} query The search term (e.g. 'VWCE', 'Apple').
 * @returns {Promise<Array<{symbol, name, exchange, country, currency, type, mic_code}>>}
 */
async function searchSymbol(query) {
    if (!TWELVE_DATA_API_KEY) {
        logger.warn('[TwelveData] TWELVE_DATA_API_KEY is not set. Skipping symbol search.');
        return [];
    }

    const url = `${BASE_URL}/symbol_search`;

    await acquireImportSlot();
    logger.info(`[TwelveData] Searching symbols for: ${query}`);

    try {
        const response = await axios.get(url, {
            timeout: 10000,
            params: { symbol: query, outputsize: 10, apikey: TWELVE_DATA_API_KEY },
        });

        if (response.data.status === 'error') {
            logger.warn(`[TwelveData] Search error: ${response.data.message}`);
            return [];
        }

        const results = (response.data.data || []).map(item => ({
            symbol: item.symbol,
            name: item.instrument_name,
            exchange: item.exchange,
            country: item.country,
            currency: item.currency,
            type: item.instrument_type,
            mic_code: item.mic_code,
        }));

        logger.info(`[TwelveData] Found ${results.length} results for "${query}"`);
        return results;
    } catch (error) {
        logger.error(`[TwelveData] Error searching symbols for "${query}"`, { error: error.message });
        return [];
    }
}

/**
 * Fetches the profile for a symbol (ISIN, exchange, currency, sector).
 * @param {string} symbol The ticker symbol.
 * @param {Object} [options] Optional parameters.
 * @param {string} [options.micCode] ISO-10383 MIC code for exchange disambiguation (e.g. 'XPAR', 'XETR').
 * @returns {Promise<{isin, exchange, name, currency, sector, type}|null>}
 */
async function getSymbolProfile(symbol, { micCode } = {}) {
    if (!TWELVE_DATA_API_KEY) {
        logger.warn('[TwelveData] TWELVE_DATA_API_KEY is not set. Skipping profile fetch.');
        return null;
    }

    const url = `${BASE_URL}/profile`;

    await acquireImportSlot();
    logger.info(`[TwelveData] Fetching profile for ${symbol}`);

    try {
        const response = await axios.get(url, {
            timeout: 10000,
            params: { symbol, apikey: TWELVE_DATA_API_KEY, ...(micCode && { mic_code: micCode }) },
        });

        if (response.data.status === 'error') {
            logger.warn(`[TwelveData] Profile error for ${symbol}: ${response.data.message}`);
            return null;
        }

        return {
            isin: response.data.isin || null,
            exchange: response.data.exchange || null,
            micCode: response.data.mic_code || null,
            name: response.data.name || null,
            currency: response.data.currency || null,
            sector: response.data.sector || null,
            type: response.data.type || null,
            industry: response.data.industry || null,
            country: response.data.country || null,
            description: response.data.description || null,
            logoUrl: response.data.logo || null,
            ceo: response.data.CEO || null,
            employees: response.data.employees ? parseInt(response.data.employees, 10) : null,
            website: response.data.website || null,
        };
    } catch (error) {
        logger.error(`[TwelveData] Error fetching profile for ${symbol}`, { error: error.message });
        return null;
    }
}

/**
 * Fetches historical earnings data for a symbol from Twelve Data.
 * Returns EPS estimates, actuals, and surprise percentages.
 * @param {string} symbol The ticker symbol.
 * @param {Object} [options] Optional parameters.
 * @param {string} [options.micCode] ISO-10383 MIC code for exchange disambiguation.
 * @returns {Promise<{meta: Object, earnings: Array}|null>}
 */
async function getEarnings(symbol, { micCode } = {}) {
    if (!TWELVE_DATA_API_KEY) {
        logger.warn('[TwelveData] TWELVE_DATA_API_KEY is not set. Skipping earnings fetch.');
        return null;
    }

    const url = `${BASE_URL}/earnings`;

    await acquireFundamentalsSlot();
    logger.info(`[TwelveData] Fetching earnings for ${symbol}`);

    try {
        // Request 2 years of historical earnings to ensure we get past quarters
        // with actual EPS data. Without start_date, Twelve Data may return only
        // upcoming/future earnings dates (e.g. JPM) where eps_actual is null.
        const twoYearsAgo = new Date();
        twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
        const startDate = twoYearsAgo.toISOString().split('T')[0]; // YYYY-MM-DD

        const response = await axios.get(url, {
            timeout: 10000,
            params: {
                symbol,
                apikey: TWELVE_DATA_API_KEY,
                start_date: startDate,
                ...(micCode && { mic_code: micCode }),
            },
        });

        if (response.data.status === 'error') {
            logger.warn(`[TwelveData] Earnings error for ${symbol}: ${response.data.message}`);
            return null;
        }

        const meta = response.data.meta || {};
        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];

        const earnings = (response.data.earnings || []).map(e => ({
            date: e.date || null,
            epsEstimate: safeParseFloat(e.eps_estimate),
            epsActual: safeParseFloat(e.eps_actual),
            difference: safeParseFloat(e.difference),
            surprisePrc: safeParseFloat(e.surprise_prc),
        }));

        // Filter out future-dated earnings (scheduled but not yet reported)
        const pastEarnings = earnings.filter(e => e.date && e.date <= todayStr);
        const futureCount = earnings.length - pastEarnings.length;

        const withActual = pastEarnings.filter(e => e.epsActual != null).length;
        logger.info(`[TwelveData] Earnings for ${symbol}: ${earnings.length} total records, ${futureCount} future (excluded), ${pastEarnings.length} past (${withActual} with actual EPS)`);
        return { meta, earnings: pastEarnings };
    } catch (error) {
        logger.error(`[TwelveData] Error fetching earnings for ${symbol}`, { error: error.message });
        return null;
    }
}

/**
 * Fetches historical dividend data for a symbol from Twelve Data.
 * Returns ex-dividend dates and payment amounts.
 * @param {string} symbol The ticker symbol.
 * @param {Object} [options] Optional parameters.
 * @param {string} [options.micCode] ISO-10383 MIC code for exchange disambiguation.
 * @returns {Promise<{meta: Object, dividends: Array}|null>}
 */
async function getDividends(symbol, { micCode } = {}) {
    if (!TWELVE_DATA_API_KEY) {
        logger.warn('[TwelveData] TWELVE_DATA_API_KEY is not set. Skipping dividends fetch.');
        return null;
    }

    const url = `${BASE_URL}/dividends`;

    await acquireFundamentalsSlot();
    logger.info(`[TwelveData] Fetching dividends for ${symbol}`);

    try {
        const response = await axios.get(url, {
            timeout: 10000,
            params: { symbol, apikey: TWELVE_DATA_API_KEY, ...(micCode && { mic_code: micCode }) },
        });

        if (response.data.status === 'error') {
            logger.warn(`[TwelveData] Dividends error for ${symbol}: ${response.data.message}`);
            return null;
        }

        const meta = response.data.meta || {};
        const dividends = (response.data.dividends || []).map(d => ({
            exDate: d.ex_date || null,
            amount: safeParseFloat(d.amount),
        }));

        logger.info(`[TwelveData] Dividends for ${symbol}: ${dividends.length} records`);
        return { meta, dividends };
    } catch (error) {
        logger.error(`[TwelveData] Error fetching dividends for ${symbol}`, { error: error.message });
        return null;
    }
}

module.exports = {
    getHistoricalPrice,
    getLatestPrice,
    searchSymbol,
    getSymbolProfile,
    getEarnings,
    getDividends,
};
