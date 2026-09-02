const { PrismaClient } = require('@prisma/client');
const { Decimal } = require('@prisma/client/runtime/library');
const axios = require('axios');
const logger = require('../utils/logger');
const twelveDataService = require('./twelveDataService');

const prisma = new PrismaClient();

const CURRENCYLAYER_API_KEY = process.env.CURRENCYLAYER_API_KEY;
const CURRENCYLAYER_BASE_URL = "https://api.currencylayer.com/historical";

const SUPPORTED_CURRENCY_PROVIDERS = ['TWELVE_DATA', 'CURRENCYLAYER'];

/**
 * Resolves the active FX-rate provider once, at module load (process-wide —
 * there is no per-tenant selection). Precedence:
 *   1. An explicit, valid `CURRENCY_PROVIDER` always wins.
 *   2. Else, if `TWELVE_DATA_API_KEY` is present → TWELVE_DATA (Twelve Data is
 *      preferred whenever its key exists, even alongside a CurrencyLayer key).
 *   3. Else, if `CURRENCYLAYER_API_KEY` is present → CURRENCYLAYER (legacy
 *      instance — no silent loss of FX auto-fetch on upgrade).
 *   4. Else → TWELVE_DATA (default; auto-fetch simply disabled until a key is
 *      added — manual currency-rate entry still works).
 * @returns {'TWELVE_DATA'|'CURRENCYLAYER'}
 */
function resolveCurrencyProvider() {
  const explicit = (process.env.CURRENCY_PROVIDER || '').trim().toUpperCase();
  if (explicit) {
    if (SUPPORTED_CURRENCY_PROVIDERS.includes(explicit)) return explicit;
    logger.warn(
      `[CurrencyService] Unknown CURRENCY_PROVIDER="${process.env.CURRENCY_PROVIDER}". ` +
        `Supported: ${SUPPORTED_CURRENCY_PROVIDERS.join(', ')}. Falling back to auto-detection.`
    );
  }
  if (process.env.TWELVE_DATA_API_KEY) return 'TWELVE_DATA';
  if (process.env.CURRENCYLAYER_API_KEY) return 'CURRENCYLAYER';
  return 'TWELVE_DATA';
}

const ACTIVE_CURRENCY_PROVIDER = resolveCurrencyProvider();
const ACTIVE_CURRENCY_PROVIDER_ID =
  ACTIVE_CURRENCY_PROVIDER === 'CURRENCYLAYER' ? 'currencylayer' : 'twelvedata';

logger.info(`[CurrencyService] Active FX-rate provider: ${ACTIVE_CURRENCY_PROVIDER}`);

/**
 * Fetches an historical exchange rate from the CurrencyLayer API (legacy path,
 * used only when `CURRENCY_PROVIDER=CURRENCYLAYER`).
 * @param {string} date - The date in 'YYYY-MM-DD' format.
 * @param {string} currencyFrom - The source currency code.
 * @param {string} currencyTo - The target currency code.
 * @returns {Promise<number|null>} The exchange rate or null.
 */
async function fetchCurrencyLayerRate(date, currencyFrom, currencyTo) {
  if (!CURRENCYLAYER_API_KEY) {
    logger.error('[CurrencyService] CURRENCYLAYER_API_KEY is not set.');
    return null;
  }
  const url = `${CURRENCYLAYER_BASE_URL}?access_key=${CURRENCYLAYER_API_KEY}&date=${date}&source=${currencyFrom}&currencies=${currencyTo}`;

  try {
    logger.info(`[CurrencyService] Fetching rate from CurrencyLayer: ${currencyFrom}->${currencyTo} on ${date}`);
    const response = await axios.get(url, { timeout: 10000 });
    const data = response.data;

    if (!data.success || !data.quotes) {
      logger.error('[CurrencyService] CurrencyLayer API call was not successful or returned no quotes.', { responseData: data });
      return null;
    }

    return data.quotes[`${currencyFrom}${currencyTo}`];

  } catch (e) {
    logger.error(`[CurrencyService] API error for ${currencyFrom}->${currencyTo} on ${date}: ${e.message}`);
    return null;
  }
}

/**
 * Fetches an historical exchange rate from the configured FX provider.
 *
 * Dispatches to Twelve Data (default) or CurrencyLayer (legacy) based on the
 * resolved `CURRENCY_PROVIDER`. Both branches share the same contract: return
 * the number `X` where `1 currencyFrom = X currencyTo`, or `null` on any
 * failure (never throw).
 *
 * @param {string} date - The date in 'YYYY-MM-DD' format.
 * @param {string} currencyFrom - The source currency code.
 * @param {string} currencyTo - The target currency code.
 * @returns {Promise<number|null>} The exchange rate or null.
 */
async function fetchHistoricalRate(date, currencyFrom, currencyTo) {
  if (ACTIVE_CURRENCY_PROVIDER === 'TWELVE_DATA') {
    return twelveDataService.getFxRate(currencyFrom, currencyTo, new Date(`${date}T00:00:00.000Z`));
  }
  return fetchCurrencyLayerRate(date, currencyFrom, currencyTo);
}

/**
 * Retrieves a currency rate, from local cache, DB, or external API.
 *
 * ⚠️  WRITE-THROUGH CACHE — AUTHORIZED CALLERS ONLY
 *
 * This helper is a write-through cache: on a miss it calls the configured
 * external FX provider (Twelve Data by default, CurrencyLayer legacy — both
 * are external HTTP egress with metered billing) AND inserts a row into the
 * `CurrencyRate` table. It is therefore a **side-effect-producing** function
 * and must only be called from the valuation pipeline:
 *
 *   - portfolioWorker (valuation, cash processing, liability processing)
 *   - price-fetcher (portfolio asset valuation strategies)
 *
 * The insights engine (insightService.js) and any other read-only consumer
 * **must never** call this function — use `getRatesForDateRange()` below
 * combined with an in-memory nearest-prior lookup instead. See the
 * insights-v2 refactor for the reference pattern:
 *   apps/backend/src/services/insightService.js → prefetchRatesForTier()
 *
 * A regression here previously caused the daily insights cron to populate
 * `CurrencyRate` with fresh rows every morning and triggered FX-provider
 * billing alerts (historically CurrencyLayer). The hygiene test
 *   apps/backend/src/__tests__/unit/services/insightService.hygiene.test.js
 * enforces this boundary at CI time.
 *
 * @param {Date} dateObj - The date object for the rate.
 * @param {string} currencyFrom - The source currency code.
 * @param {string} currencyTo - The target currency code.
 * @param {object} rateCache - In-memory cache for the current job.
 * @returns {Promise<Decimal|null>} The exchange rate or null.
 */
async function getOrCreateCurrencyRate(dateObj, currencyFrom, currencyTo, rateCache) {
  const dateStr = dateObj.toISOString().slice(0, 10);
  const cacheKey = `${dateStr}_${currencyFrom}_${currencyTo}`;

  if (rateCache[cacheKey] !== undefined) {
    return rateCache[cacheKey];
  }

  const year = dateObj.getUTCFullYear();
  const month = dateObj.getUTCMonth() + 1;
  const day = dateObj.getUTCDate();

  // 1. Check DB
  const rate = await prisma.currencyRate.findUnique({
    where: {
      year_month_day_currencyFrom_currencyTo: {
        year, month, day, currencyFrom, currencyTo
      }
    }
  });

  if (rate) {
    rateCache[cacheKey] = rate.value;
    return rate.value;
  }

  // 2. Fetch from external API
  const fetchedValue = await fetchHistoricalRate(dateStr, currencyFrom, currencyTo);
  if (fetchedValue) {
    const valueAsDecimal = new Decimal(fetchedValue);
    // 3. Store in DB
    await prisma.currencyRate.create({
      data: {
        year,
        month,
        day,
        currencyFrom,
        currencyTo,
        value: valueAsDecimal,
        provider: ACTIVE_CURRENCY_PROVIDER_ID,
      },
    });
    rateCache[cacheKey] = valueAsDecimal;
    // Delay to respect API rate limits on free tiers
    await new Promise(res => setTimeout(res, 50)); 
    return valueAsDecimal;
  }

  rateCache[cacheKey] = null; // Cache failure to avoid refetching
  return null;
}

/**
 * Fetches all currency rates for a given pair within a specified date range from the database.
 * @param {Date} startDate - The start of the date range.
 * @param {Date} endDate - The end of the date range.
 * @param {string} currencyFrom - The source currency code.
 * @param {string} currencyTo - The target currency code.
 * @returns {Promise<Map<string, Decimal>>} A map of date strings ('YYYY-MM-DD') to exchange rates.
 */
async function getRatesForDateRange(startDate, endDate, currencyFrom, currencyTo) {
    const startYear = startDate.getUTCFullYear();
    const endYear = endDate.getUTCFullYear();
    const rateMap = new Map();

    logger.info(`[CurrencyService] Bulk fetching rates for ${currencyFrom}->${currencyTo} from ${startDate.toISOString().slice(0, 10)} to ${endDate.toISOString().slice(0, 10)}`);

    try {
        // Fetch rates year by year to avoid overloading the Prisma Data Proxy
        for (let year = startYear; year <= endYear; year++) {
            const ratesForYear = await prisma.currencyRate.findMany({
                where: {
                    year,
                    currencyFrom,
                    currencyTo,
                },
            });

            for (const rate of ratesForYear) {
                const month = String(rate.month).padStart(2, '0');
                const day = String(rate.day).padStart(2, '0');
                const dateStr = `${rate.year}-${month}-${day}`;
                
                // Manually filter for the exact date range
                const currentDate = new Date(dateStr);
                // --- Start Change: Normalize dates to avoid timezone/time issues ---
                const normalizedStartDate = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
                const normalizedEndDate = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()));

                if (currentDate >= normalizedStartDate && currentDate <= normalizedEndDate) {
                // --- End Change ---
                    rateMap.set(dateStr, rate.value);
                }
            }
        }

        logger.info(`[CurrencyService] Found ${rateMap.size} rates in the database for the given range.`);
        return rateMap;
    } catch (error) {
        logger.error(`[CurrencyService] Error bulk fetching currency rates: ${error.message}`, {
            startDate,
            endDate,
            currencyFrom,
            currencyTo,
            stack: error.stack,
        });
        return new Map(); // Return an empty map on error
    }
}

module.exports = {
    getOrCreateCurrencyRate,
    fetchHistoricalRate,
    getRatesForDateRange,
    // Exported for test isolation / observability — not used by insightService.
    resolveCurrencyProvider,
    SUPPORTED_CURRENCY_PROVIDERS,
    ACTIVE_CURRENCY_PROVIDER,
}