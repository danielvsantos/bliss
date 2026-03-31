const { PrismaClient } = require('@prisma/client');
const { Decimal } = require('@prisma/client/runtime/library');
const axios = require('axios');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

const CURRENCYLAYER_API_KEY = process.env.CURRENCYLAYER_API_KEY;
const CURRENCYLAYER_BASE_URL = "https://api.currencylayer.com/historical";

/**
 * Fetches an historical exchange rate from the CurrencyLayer API.
 * @param {string} date - The date in 'YYYY-MM-DD' format.
 * @param {string} currencyFrom - The source currency code.
 * @param {string} currencyTo - The target currency code.
 * @returns {Promise<number|null>} The exchange rate or null.
 */
async function fetchHistoricalRate(date, currencyFrom, currencyTo) {
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
 * Retrieves a currency rate, from local cache, DB, or external API.
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
        provider: "currencylayer",
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
} 