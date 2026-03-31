import prisma from '../prisma/prisma.js';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * Converts an amount from one currency to another using CurrencyRate table.
 * Uses forward-fill: if no rate exists for the exact date, looks back up to 7 days.
 *
 * @param {Decimal|number} amount The amount to convert.
 * @param {string} fromCurrency Source currency code (e.g. 'USD').
 * @param {string} toCurrency Target currency code (e.g. 'EUR').
 * @param {Date} [date] The date for the rate lookup (defaults to today).
 * @returns {Promise<Decimal|null>} Converted amount, or null if no rate found.
 */
export async function convertCurrency(amount, fromCurrency, toCurrency, date = new Date()) {
  if (fromCurrency === toCurrency) {
    return new Decimal(amount);
  }

  const rate = await findRate(fromCurrency, toCurrency, date);
  if (!rate) return null;

  return new Decimal(amount).times(rate);
}

/**
 * Finds the exchange rate between two currencies, with forward-fill lookback.
 * Tries direct rate first, then inverse.
 *
 * @param {string} from Source currency code.
 * @param {string} to Target currency code.
 * @param {Date} date The target date.
 * @returns {Promise<Decimal|null>}
 */
async function findRate(from, to, date) {
  const MAX_LOOKBACK = 7;

  for (let i = 0; i <= MAX_LOOKBACK; i++) {
    const d = new Date(date);
    d.setDate(d.getDate() - i);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const day = d.getDate();

    // Try direct rate
    const direct = await prisma.currencyRate.findUnique({
      where: {
        year_month_day_currencyFrom_currencyTo: { year, month, day, currencyFrom: from, currencyTo: to },
      },
    });
    if (direct) return direct.value;

    // Try inverse rate
    const inverse = await prisma.currencyRate.findUnique({
      where: {
        year_month_day_currencyFrom_currencyTo: { year, month, day, currencyFrom: to, currencyTo: from },
      },
    });
    if (inverse && !new Decimal(inverse.value).isZero()) {
      return new Decimal(1).dividedBy(inverse.value);
    }
  }

  return null;
}

/**
 * Batch-fetches rates for a set of dates (for history endpoint efficiency).
 * Returns a Map<dateStr, Decimal> of rates.
 *
 * @param {string} from Source currency code.
 * @param {string} to Target currency code.
 * @param {string[]} dateStrings Array of 'YYYY-MM-DD' date strings.
 * @returns {Promise<Map<string, Decimal>>}
 */
export async function batchFetchRates(from, to, dateStrings) {
  const rateMap = new Map();
  if (from === to) {
    for (const ds of dateStrings) {
      rateMap.set(ds, new Decimal(1));
    }
    return rateMap;
  }

  // Fetch all potentially relevant rates in one query
  const dates = dateStrings.map(ds => new Date(ds));
  const minDate = new Date(Math.min(...dates));
  minDate.setDate(minDate.getDate() - 7); // Allow for lookback

  const rates = await prisma.currencyRate.findMany({
    where: {
      OR: [
        { currencyFrom: from, currencyTo: to },
        { currencyFrom: to, currencyTo: from },
      ],
      year: { gte: minDate.getFullYear() },
    },
    orderBy: [{ year: 'desc' }, { month: 'desc' }, { day: 'desc' }],
  });

  // Build a lookup map
  const rateLookup = new Map();
  for (const r of rates) {
    const key = `${r.year}-${String(r.month).padStart(2, '0')}-${String(r.day).padStart(2, '0')}:${r.currencyFrom}:${r.currencyTo}`;
    rateLookup.set(key, r.value);
  }

  for (const ds of dateStrings) {
    const d = new Date(ds);
    let found = false;

    for (let i = 0; i <= 7; i++) {
      const lookupDate = new Date(d);
      lookupDate.setDate(lookupDate.getDate() - i);
      const y = lookupDate.getFullYear();
      const m = String(lookupDate.getMonth() + 1).padStart(2, '0');
      const dy = String(lookupDate.getDate()).padStart(2, '0');

      const directKey = `${y}-${m}-${dy}:${from}:${to}`;
      if (rateLookup.has(directKey)) {
        rateMap.set(ds, new Decimal(rateLookup.get(directKey)));
        found = true;
        break;
      }

      const inverseKey = `${y}-${m}-${dy}:${to}:${from}`;
      if (rateLookup.has(inverseKey)) {
        const val = new Decimal(rateLookup.get(inverseKey));
        if (!val.isZero()) {
          rateMap.set(ds, new Decimal(1).dividedBy(val));
          found = true;
          break;
        }
      }
    }

    if (!found) {
      rateMap.set(ds, null);
    }
  }

  return rateMap;
}
