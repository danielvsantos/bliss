const axios = require('axios');
const logger = require('../utils/logger');
const twelveDataBudget = require('../utils/twelveDataBudget');
const { getTwelveDataContext } = require('../utils/twelveDataContext');
const { creditCost, DEFAULT_PRIORITY } = require('../config/twelveDataCredits');
const { Decimal } = require('@prisma/client/runtime/library');

const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;
const BASE_URL = 'https://api.twelvedata.com';

/**
 * Safely parse a numeric value from Twelve Data.
 * Returns null for null, undefined, empty strings, and NaN results.
 */
function safeParseFloat(value) {
    if (value == null || value === '') return null;
    const num = parseFloat(value);
    return Number.isNaN(num) ? null : num;
}

/** Consecutive Twelve Data 429s tolerated per request before giving up (the caller gets its null path). */
const MAX_RATE_LIMIT_RETRIES = 3;

function isRateLimited(response, error) {
    const status = error ? error.response?.status : response?.status;
    if (status === 429) return true;
    const body = error ? error.response?.data : response?.data;
    return Boolean(body && body.status === 'error' && Number(body.code) === 429);
}

/**
 * How long to pause after a 429: the `Retry-After` header (seconds or an HTTP
 * date) when present, otherwise until one second past the next minute
 * boundary, when Twelve Data's per-minute counter resets.
 */
function retryAfterMs(headers) {
    const raw = headers?.['retry-after'];
    if (raw != null && raw !== '') {
        const seconds = Number(raw);
        if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, seconds * 1000);
        const at = Date.parse(raw);
        if (!Number.isNaN(at)) return Math.max(1000, at - Date.now());
    }
    return 60_000 - (Date.now() % 60_000) + 1000;
}

/**
 * The single path to api.twelvedata.com (#150). Reserves the endpoint's credits
 * from the shared budget at the caller's priority (from the Twelve Data
 * context, see `utils/twelveDataContext.js`), makes the request and records
 * usage on the context. A 429 pauses the shared budget and retries; waiting
 * never throws. Non-429 errors are rethrown unchanged for the caller's catch.
 *
 * @param {string} endpoint Path without the leading slash, e.g. 'time_series'.
 * @param {Object} params Query params, including `apikey`.
 * @returns {Promise<Object>} The axios response.
 */
async function tdGet(endpoint, params) {
    const ctx = getTwelveDataContext();
    const priority = ctx?.priority ?? DEFAULT_PRIORITY;
    if (!ctx) {
        logger.debug('[TwelveData] Call outside a priority context, using the default priority', { endpoint });
    }
    const credits = creditCost(endpoint);

    for (let attempt = 0; ; attempt++) {
        const reservation = await twelveDataBudget.acquire({ endpoint, credits, priority });
        if (ctx?.usage) {
            ctx.usage.waitedMs += reservation.waitedMs;
            ctx.usage.mode = reservation.mode;
        }

        let response;
        let error;
        try {
            response = await axios.get(`${BASE_URL}/${endpoint}`, { timeout: 10000, params });
        } catch (err) {
            error = err;
        }
        const headers = (error ? error.response?.headers : response?.headers) || {};

        if (ctx?.usage) {
            ctx.usage.credits += reservation.credits;
            ctx.usage.calls += 1;
        }
        logger.debug('[TwelveData] Credits', {
            endpoint,
            reserved: reservation.credits,
            minuteUsed: safeParseFloat(headers['api-credits-used']),
            minuteLeft: safeParseFloat(headers['api-credits-left']),
        });

        if (!isRateLimited(response, error)) {
            if (error) throw error;
            return response;
        }

        const pauseMs = retryAfterMs(headers);
        twelveDataBudget.pause(pauseMs);
        if (ctx?.usage) ctx.usage.rateLimited += 1;
        if (attempt >= MAX_RATE_LIMIT_RETRIES) {
            logger.warn('[TwelveData] Still rate limited after retries, giving up on this request', {
                endpoint, symbol: params?.symbol, attempts: attempt + 1,
            });
            if (error) throw error;
            return response;
        }
        logger.warn('[TwelveData] Rate limited (429), pausing the shared budget and retrying', {
            endpoint, symbol: params?.symbol, pauseMs, attempt: attempt + 1,
        });
    }
}

/**
 * Fetches the historical closing price for a symbol from Twelve Data.
 * Backtracks up to 3 days to find a valid price (weekends/holidays).
 * @param {string} symbol The ticker symbol (e.g. 'VWCE.DEX', 'AAPL').
 * @param {Date} date The target date.
 * @param {Object} [options] Optional parameters.
 * @param {string} [options.micCode] ISO-10383 MIC code for exchange disambiguation (e.g. 'XPAR', 'XETR').
 * @param {string} [options.expectedCurrency] Currency the listing trades in. When a mic_code
 *   call fails, the retry without it is only trusted if Twelve Data reports this currency.
 * @returns {Promise<{price: Decimal, source: string}|null>}
 */
async function getHistoricalPrice(symbol, date, { micCode, expectedCurrency } = {}) {
    if (!TWELVE_DATA_API_KEY) {
        logger.warn('[TwelveData] TWELVE_DATA_API_KEY is not set. Skipping API call.');
        return null;
    }

    // Request 4 days ending at target date to cover weekend backtrack
    const endDate = date.toISOString().split('T')[0];
    const startDate = new Date(date);
    startDate.setDate(startDate.getDate() - 3);
    const startStr = startDate.toISOString().split('T')[0];

    const endpoint = 'time_series';

    logger.info(`[TwelveData] Fetching historical price for ${symbol}`, { startDate: startStr, endDate, micCode: micCode || 'none' });

    try {
        const response = await tdGet(endpoint, { symbol, interval: '1day', start_date: startStr, end_date: endDate, apikey: TWELVE_DATA_API_KEY, ...(micCode && { mic_code: micCode }) });

        if (response.data.status === 'error') {
            // If the call failed WITH a mic_code, retry WITHOUT it. The mic_code
            // might not match TwelveData's internal exchange mapping for ETFs/funds
            // (e.g., mic_code "XNAS" for a fund that TwelveData indexes differently).
            // The bare symbol resolves to Twelve Data's default listing, which can be
            // a different instrument (NVD on Xetra is Nvidia, on Nasdaq a 2x short
            // ETF, #134), so its price is only used when its currency matches.
            if (micCode) {
                logger.info(`[TwelveData] Retrying ${symbol} without mic_code (was: ${micCode})`);
                const retryResponse = await tdGet(endpoint, { symbol, interval: '1day', start_date: startStr, end_date: endDate, apikey: TWELVE_DATA_API_KEY });

                if (retryResponse.data.status === 'error') {
                    logger.warn(`[TwelveData] API error for ${symbol} (retry without mic_code): ${retryResponse.data.message}`);
                    return null;
                }

                const retryValues = retryResponse.data.values;
                if (!retryValues || retryValues.length === 0) {
                    logger.warn(`[TwelveData] No time series data for ${symbol} around ${endDate} (retry without mic_code).`);
                    return null;
                }

                const retryCurrency = retryResponse.data.meta?.currency;
                if (!expectedCurrency || !retryCurrency
                    || retryCurrency.toUpperCase() !== expectedCurrency.toUpperCase()) {
                    logger.warn(`[TwelveData] Rejecting ${symbol} price resolved without mic_code: listing currency ${retryCurrency || 'unknown'} does not match expected ${expectedCurrency || 'unknown'} (mic_code ${micCode}).`);
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

    const endpoint = 'quote';

    logger.info(`[TwelveData] Fetching latest price for ${symbol}`);

    try {
        const response = await tdGet(endpoint, { symbol, apikey: TWELVE_DATA_API_KEY, ...(micCode && { mic_code: micCode }) });

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

    const endpoint = 'symbol_search';

    logger.info(`[TwelveData] Searching symbols for: ${query}`);

    try {
        const response = await tdGet(endpoint, { symbol: query, outputsize: 10, apikey: TWELVE_DATA_API_KEY });

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

    const endpoint = 'profile';

    logger.info(`[TwelveData] Fetching profile for ${symbol}`);

    try {
        const response = await tdGet(endpoint, { symbol, apikey: TWELVE_DATA_API_KEY, ...(micCode && { mic_code: micCode }) });

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

    const endpoint = 'earnings';

    logger.info(`[TwelveData] Fetching earnings for ${symbol}`);

    try {
        // Request 2 years of historical earnings to ensure we get past quarters
        // with actual EPS data. Without start_date, Twelve Data may return only
        // upcoming/future earnings dates (e.g. JPM) where eps_actual is null.
        const twoYearsAgo = new Date();
        twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
        const startDate = twoYearsAgo.toISOString().split('T')[0]; // YYYY-MM-DD

        const response = await tdGet(endpoint, {
            symbol,
            apikey: TWELVE_DATA_API_KEY,
            start_date: startDate,
            ...(micCode && { mic_code: micCode }),
        });

        if (response.data.status === 'error') {
            logger.warn(`[TwelveData] Earnings error for ${symbol}: ${response.data.message}`);
            return null;
        }

        // Sanity-bound the response: Twelve Data occasionally returns rows
        // with malformed or wildly out-of-range dates. Anything older than
        // 5 years is useless for trailing-EPS calculations; anything more
        // than 1 year in the future is data noise. We do NOT filter out
        // near-future entries here — the service layer applies its own
        // time-zone-aware grace window when deciding which entries can
        // contribute to trailing EPS.
        const meta = response.data.meta || {};
        const today = new Date();
        const fiveYearsAgo = new Date(today);
        fiveYearsAgo.setFullYear(today.getFullYear() - 5);
        const oneYearAhead = new Date(today);
        oneYearAhead.setFullYear(today.getFullYear() + 1);

        const earnings = (response.data.earnings || [])
            .map(e => ({
                date: e.date || null,
                epsEstimate: safeParseFloat(e.eps_estimate),
                epsActual: safeParseFloat(e.eps_actual),
                difference: safeParseFloat(e.difference),
                surprisePrc: safeParseFloat(e.surprise_prc),
            }))
            .filter(e => {
                if (!e.date) return false;
                const d = new Date(e.date);
                if (Number.isNaN(d.getTime())) return false;
                return d >= fiveYearsAgo && d <= oneYearAhead;
            })
            // Newest-first. The Twelve Data response is documented as sorted
            // but is not in practice; consumers rely on slice(0, 4) to grab
            // the trailing 4 quarters, so we enforce ordering here.
            .sort((a, b) => new Date(b.date) - new Date(a.date));

        const withActual = earnings.filter(e => e.epsActual != null).length;
        logger.info(`[TwelveData] Earnings for ${symbol}: ${earnings.length} valid records (${withActual} with actual EPS)`);
        return { meta, earnings };
    } catch (error) {
        logger.error(`[TwelveData] Error fetching earnings for ${symbol}`, { error: error.message });
        return null;
    }
}

/**
 * Fetches historical dividend data for a symbol from Twelve Data.
 * Returns ex-dividend dates and payment amounts.
 *
 * `range: 'full'` is required: without it the endpoint returns ONLY the most
 * recent dividend, so the trailing-12-month sum in securityMasterService
 * collapses to a single payment (~4x too low for quarterly payers, ~12x for
 * monthly). Same credit cost as the default call.
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

    const endpoint = 'dividends';

    logger.info(`[TwelveData] Fetching dividends for ${symbol}`);

    try {
        const response = await tdGet(endpoint, { symbol, range: 'full', apikey: TWELVE_DATA_API_KEY, ...(micCode && { mic_code: micCode }) });

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

/**
 * Fetches an ETF's composition from Twelve Data /etfs/world/composition
 * (Equity Analysis #79). Keeps sector weights, country allocation and asset
 * allocation; `top_holdings` is dropped.
 *
 * Weights are returned as Twelve Data sends them; consumers normalize them
 * with `normalizeEtfComposition` from @bliss/shared/portfolio.
 *
 * @param {string} symbol
 * @param {Object} [options]
 * @param {string} [options.micCode] ISO-10383 MIC code
 * @returns {Promise<{ sectors: Array<{sector: string, weight: number}>,
 *   countries: Array<{country: string, weight: number}>, assetAllocation: Object,
 *   creditsUsed: number|null }|{ unavailable: true, status: number, message: string|null }|null>}
 *   `{ unavailable: true }` when Twelve Data refuses the request outright
 *   (401/403/404 — e.g. the endpoint isn't on the API plan, or the symbol isn't
 *   covered); null on a transient failure.
 */
/** Twelve Data codes meaning "this request will keep being refused" (plan / auth / coverage). */
const COMPOSITION_REFUSED_CODES = new Set([401, 403, 404]);

async function getEtfComposition(symbol, { micCode } = {}) {
    if (!TWELVE_DATA_API_KEY) {
        logger.warn('[TwelveData] TWELVE_DATA_API_KEY is not set. Skipping ETF composition fetch.');
        return null;
    }

    const endpoint = 'etfs/world/composition';

    logger.info(`[TwelveData] Fetching ETF composition for ${symbol}`);

    try {
        const response = await tdGet(endpoint, { symbol, apikey: TWELVE_DATA_API_KEY, ...(micCode && { mic_code: micCode }) });

        if (response.data.status === 'error') {
            const code = Number(response.data.code) || null;
            logger.warn(`[TwelveData] ETF composition error for ${symbol}: ${response.data.message}`, { code });
            return COMPOSITION_REFUSED_CODES.has(code)
                ? { unavailable: true, status: code, message: response.data.message || null }
                : null;
        }

        const composition = response.data.etf?.composition || response.data.composition || null;
        if (!composition) {
            logger.warn(`[TwelveData] ETF composition for ${symbol}: empty response`);
            return null;
        }

        const sectors = (composition.major_market_sectors || [])
            .map((s) => ({ sector: s.sector || null, weight: safeParseFloat(s.weight) }))
            .filter((s) => s.sector && s.weight != null);
        const countries = (composition.country_allocation || [])
            .map((c) => ({ country: c.country || null, weight: safeParseFloat(c.allocation ?? c.weight) }))
            .filter((c) => c.country && c.weight != null);
        const assetAllocation = {};
        for (const [key, value] of Object.entries(composition.asset_allocation || {})) {
            const n = safeParseFloat(value);
            if (n != null) assetAllocation[key] = n;
        }

        // Twelve Data's minute counter after this call (not the cost of the call, #150).
        const creditsUsed = safeParseFloat(response.headers?.['api-credits-used']);
        logger.info(`[TwelveData] ETF composition for ${symbol}: ${sectors.length} sectors, ${countries.length} countries`, {
            creditsUsed,
            creditsLeft: safeParseFloat(response.headers?.['api-credits-left']),
        });

        return { sectors, countries, assetAllocation, creditsUsed };
    } catch (error) {
        // Axios throws on HTTP 4xx/5xx; Twelve Data's reason is in the body.
        const status = error.response?.status || null;
        const message = error.response?.data?.message || null;
        if (COMPOSITION_REFUSED_CODES.has(status)) {
            logger.warn(`[TwelveData] ETF composition refused for ${symbol} (HTTP ${status}): ${message || error.message}`);
            return { unavailable: true, status, message };
        }
        logger.error(`[TwelveData] Error fetching ETF composition for ${symbol}`, { error: error.message, status, message });
        return null;
    }
}

/**
 * Resolves a single Twelve Data forex symbol (e.g. 'EUR/USD') to a numeric
 * rate. Tries the dedicated `/exchange_rate` endpoint first (real-time, or
 * historical via the `date` param), then falls back to a `/time_series`
 * backtrack window for weekends / market holidays.
 *
 * @param {string} symbol Twelve Data forex symbol, `FROM/TO` (e.g. 'EUR/USD').
 * @param {string} dateStr Target date, `YYYY-MM-DD`.
 * @param {boolean} isToday When true, request the real-time rate (no `date` param).
 * @returns {Promise<number|null>} The rate for `symbol`, or null if unresolved.
 */
async function resolveFxSymbol(symbol, dateStr, isToday) {
    // 1. /exchange_rate — direct analogue of CurrencyLayer's `historical` call.
    try {
        const params = { symbol, apikey: TWELVE_DATA_API_KEY };
        if (!isToday) params.date = dateStr;
        logger.info(`[TwelveData] Fetching FX rate for ${symbol}`, { date: isToday ? 'latest' : dateStr });

        const response = await tdGet('exchange_rate', params);

        if (response.data && response.data.status === 'error') {
            logger.warn(`[TwelveData] exchange_rate error for ${symbol}: ${response.data.message}`);
        } else if (response.data) {
            const rate = safeParseFloat(response.data.rate);
            if (rate != null && rate > 0) {
                logger.info(`[TwelveData] FX rate for ${symbol}: ${rate}`);
                return rate;
            }
        }
    } catch (error) {
        logger.warn(`[TwelveData] exchange_rate request failed for ${symbol}: ${error.message}`);
    }

    // 2. /time_series — weekend / holiday backtrack (up to 3 prior days).
    const startDateObj = new Date(`${dateStr}T00:00:00.000Z`);
    startDateObj.setUTCDate(startDateObj.getUTCDate() - 3);
    const startStr = startDateObj.toISOString().split('T')[0];

    try {
        logger.info(`[TwelveData] Falling back to time_series for ${symbol}`, { startDate: startStr, endDate: dateStr });

        const response = await tdGet('time_series', { symbol, interval: '1day', start_date: startStr, end_date: dateStr, apikey: TWELVE_DATA_API_KEY });

        if (response.data && response.data.status === 'error') {
            logger.warn(`[TwelveData] time_series error for ${symbol}: ${response.data.message}`);
            return null;
        }

        const values = response.data && response.data.values;
        if (values && values.length > 0) {
            const close = safeParseFloat(values[0].close);
            if (close != null && close > 0) {
                logger.info(`[TwelveData] FX rate for ${symbol} on ${values[0].datetime}: ${close}`);
                return close;
            }
        }
        logger.warn(`[TwelveData] No time_series data for ${symbol} around ${dateStr}.`);
        return null;
    } catch (error) {
        logger.warn(`[TwelveData] time_series request failed for ${symbol}: ${error.message}`);
        return null;
    }
}

/**
 * Fetches an FX rate for a currency pair from Twelve Data.
 *
 * Direction semantics match the existing CurrencyLayer contract: the returned
 * number `X` satisfies `1 currencyFrom = X currencyTo`.
 *
 * Resolution order (all within Twelve Data — there is no cross-provider
 * fallback here):
 *   1. `${from}/${to}` via `/exchange_rate` (historical when `date` is set).
 *   2. `${from}/${to}` via `/time_series` (weekend / holiday backtrack).
 *   3. The inverse symbol `${to}/${from}` through the same two steps, returning
 *      `1 / value`.
 *
 * Every request draws from the shared credit budget (#150) at the caller's
 * priority, so a burst of FX lookups during a revaluation can't exceed the plan.
 *
 * @param {string} currencyFrom Source currency code (e.g. 'EUR').
 * @param {string} currencyTo Target currency code (e.g. 'USD').
 * @param {Date} [date] Target date. Omitted or today → real-time rate.
 * @returns {Promise<number|null>} The exchange rate, or null if every path fails.
 */
async function getFxRate(currencyFrom, currencyTo, date) {
    if (!TWELVE_DATA_API_KEY) {
        logger.warn('[TwelveData] TWELVE_DATA_API_KEY is not set. Skipping FX rate call.');
        return null;
    }

    if (currencyFrom === currencyTo) return 1;

    const todayStr = new Date().toISOString().split('T')[0];
    const dateStr = date ? new Date(date).toISOString().split('T')[0] : todayStr;
    const isToday = dateStr >= todayStr;

    const direct = await resolveFxSymbol(`${currencyFrom}/${currencyTo}`, dateStr, isToday);
    if (direct != null) return direct;

    const inverse = await resolveFxSymbol(`${currencyTo}/${currencyFrom}`, dateStr, isToday);
    if (inverse != null && inverse > 0) return 1 / inverse;

    logger.warn(`[TwelveData] Could not resolve FX rate for ${currencyFrom}/${currencyTo} on ${dateStr}.`);
    return null;
}

module.exports = {
    getHistoricalPrice,
    getLatestPrice,
    searchSymbol,
    getSymbolProfile,
    getEarnings,
    getDividends,
    getEtfComposition,
    getFxRate,
};
