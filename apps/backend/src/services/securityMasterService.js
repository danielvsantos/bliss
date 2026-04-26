const prisma = require('../../prisma/prisma.js');
const logger = require('../utils/logger');
const { Decimal } = require('@prisma/client/runtime/library');

/**
 * SecurityMaster service — CRUD operations and fundamental data computation.
 *
 * The SecurityMaster table stores global (non-tenant) stock fundamental data
 * sourced from Twelve Data Profile, Earnings, Dividends, and Quote APIs.
 *
 * P/E ratio and dividend yield are COMPUTED from raw earnings/dividend history
 * plus the current price, since the /statistics endpoint is not available on
 * our Twelve Data plan.
 */

/**
 * Fetch a single SecurityMaster record by symbol.
 * @param {string} symbol
 * @returns {Promise<Object|null>}
 */
async function getBySymbol(symbol) {
    return prisma.securityMaster.findUnique({ where: { symbol } });
}

/**
 * Fetch multiple SecurityMaster records by symbol array.
 * @param {string[]} symbols
 * @returns {Promise<Object[]>}
 */
async function getBySymbols(symbols) {
    if (!symbols.length) return [];
    return prisma.securityMaster.findMany({
        where: { symbol: { in: symbols } },
    });
}

/**
 * Upsert SecurityMaster from Twelve Data /profile response.
 * Only updates profile-related fields and lastProfileUpdate.
 * @param {string} symbol
 * @param {Object} profileData — Fields from twelveDataService.getSymbolProfile()
 */
async function upsertFromProfile(symbol, profileData) {
    // Resolve exchange: prefer knownMicCode (from searchSymbol disambiguation —
    // this is the authoritative source for which exchange was picked), then
    // mic_code from profile, then display name as last resort.
    let exchange = profileData.knownMicCode || profileData.micCode || null;
    if (!exchange) {
        // Profile returned only a display name — check if we already have a
        // MIC code stored from a previous searchSymbol/import resolution.
        const existing = await prisma.securityMaster.findUnique({
            where: { symbol },
            select: { exchange: true },
        });
        exchange = existing?.exchange || profileData.exchange || null;
    }

    const data = {
        name: profileData.name || null,
        sector: profileData.sector || null,
        industry: profileData.industry || null,
        country: profileData.country || null,
        exchange,
        currency: profileData.currency || null,
        isin: profileData.isin || null,
        description: profileData.description || null,
        logoUrl: profileData.logoUrl || null,
        assetType: profileData.type || null,
        ceo: profileData.ceo || null,
        employees: profileData.employees || null,
        website: profileData.website || null,
        lastProfileUpdate: new Date(),
    };

    // NOTE: Intentionally NOT catching errors here. A previous version swallowed
    // them with `logger.error(...)` which caused silent failures: the worker's
    // `result.profile` flag was still set to true, the `errors` counter stayed
    // at zero, and stale SecurityMaster rows accumulated with no visibility.
    // The caller (securityMasterWorker) is responsible for isolating profile
    // failures so they don't block the fundamentals refresh.
    await prisma.securityMaster.upsert({
        where: { symbol },
        create: { symbol, ...data },
        update: data,
    });
    logger.info(`[SecurityMaster] Upserted profile for ${symbol} (exchange=${exchange})`);
}

// Trust-gate windows. Tuned for quarterly reporting:
//   - 4 quarters with a 30-day buffer before the next is expected ⇒ 450 days
//   - Most recent quarter no more than 6 months stale ⇒ 180 days
//   - Dividends: most recent ex-date no more than 6 months old ⇒ 180 days
const EARNINGS_TRUST_MAX_SPAN_DAYS = 450;
const EARNINGS_TRUST_MAX_AGE_DAYS = 180;
const DIVIDEND_TRUST_MAX_AGE_DAYS = 180;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Decide whether earnings-derived fields can be trusted for downstream use
 * (insights LLM context, equity analysis page).
 *
 * Twelve Data's /earnings response is inconsistent across symbols: some
 * stocks are missing quarters, some return future-only, some report dates
 * in the exchange's local timezone (which can off-by-one a same-day refresh).
 * We need 4 quarters spanning a reasonable window AND a recent enough latest
 * report that combining trailing EPS with the current price is meaningful.
 */
function isEarningsTrustworthy(last4, peRatio) {
    if (last4.length < 4) return false;
    if (peRatio == null) return false;

    const dates = last4.map(e => new Date(e.date).getTime()).sort((a, b) => b - a);
    const newestMs = dates[0];
    const oldestMs = dates[dates.length - 1];

    const spanDays = (newestMs - oldestMs) / MS_PER_DAY;
    if (spanDays > EARNINGS_TRUST_MAX_SPAN_DAYS) return false;

    const ageDays = (Date.now() - newestMs) / MS_PER_DAY;
    if (ageDays > EARNINGS_TRUST_MAX_AGE_DAYS) return false;

    return true;
}

/**
 * Decide whether dividend-derived fields can be trusted.
 *
 * Three valid states:
 *   1. Stock has never paid dividends (response array empty) — zero is the
 *      correct answer, mark trusted.
 *   2. Stock pays dividends and we have a recent ex-date (≤180 days) plus
 *      a current price for yield computation — mark trusted.
 *   3. Stock paid dividends historically but nothing in the last 180 days
 *      OR no current price — mark untrusted.
 */
function isDividendTrustworthy({ rawDividends, recentDividends, currentPrice }) {
    if (rawDividends.length === 0) return true;
    if (recentDividends.length === 0) return false;
    if (!currentPrice || currentPrice <= 0) return false;

    const newestMs = recentDividends
        .map(d => new Date(d.exDate).getTime())
        .filter(t => !Number.isNaN(t))
        .sort((a, b) => b - a)[0];
    if (newestMs == null) return false;

    const ageDays = (Date.now() - newestMs) / MS_PER_DAY;
    return ageDays <= DIVIDEND_TRUST_MAX_AGE_DAYS;
}

/**
 * Compute and upsert fundamental fields from earnings, dividends, and quote data.
 *
 * Computation logic:
 * - trailingEps: sum of last 4 quarters eps_actual (skipping nulls)
 * - peRatio: currentPrice / trailingEps (omitted from update if non-computable)
 * - annualizedDividend: sum of dividends with ex_date in last 12 months
 * - dividendYield: annualizedDividend / currentPrice (omitted if non-computable)
 * - latestEpsActual: most recent non-null eps_actual
 * - latestEpsSurprise: corresponding surprise_prc
 * - week52High/Low/averageVolume: from extended quote data
 * - earningsTrusted / dividendTrusted: see isEarningsTrustworthy / isDividendTrustworthy
 *
 * **Preservation rule:** when a field cannot be recomputed this run (e.g. the
 * earnings filter yields nothing), the field is OMITTED from the update payload
 * rather than being explicitly nulled. The previous value is preserved on the
 * row, but the trust flag is set to false so consumers hide it. A previous
 * version of this code unconditionally wrote `null` on the failure path, which
 * silently wiped good data when a refresh hit a transient API quirk.
 *
 * @param {string} symbol
 * @param {Object} params
 * @param {Object|null} params.earnings — From twelveDataService.getEarnings()
 * @param {Object|null} params.dividends — From twelveDataService.getDividends()
 * @param {Object|null} params.quote — From twelveDataService.getLatestPrice({ extended: true })
 */
async function upsertFundamentals(symbol, { earnings, dividends, quote }) {
    const data = {
        lastFundamentalsUpdate: new Date(),
        earningsTrusted: false,
        dividendTrusted: false,
    };

    // --- Earnings-derived fields ---
    if (earnings && earnings.earnings && earnings.earnings.length > 0) {
        // Twelve Data returns dates in the stock's exchange timezone. Comparing
        // against UTC `today` can off-by-one a same-day report (a 4:30 PM ET
        // earnings call dated `today` fails a strict `<= todayStr` check when
        // this job runs at midnight UTC, eight hours earlier). The 24-hour
        // grace absorbs that skew without resolving per-stock timezones.
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toISOString().split('T')[0];

        const withActual = earnings.earnings
            .filter(e =>
                e.epsActual != null && Number.isFinite(e.epsActual) &&
                e.date && e.date <= tomorrowStr
            )
            // Defensive resort: caller is expected to sort newest-first, but
            // this slice underpins trailing-EPS so guarantee it locally.
            .sort((a, b) => new Date(b.date) - new Date(a.date));

        logger.info(`[SecurityMaster] ${symbol}: ${earnings.earnings.length} earnings records, ${withActual.length} with actual EPS (within 24h grace window)`);

        const last4 = withActual.slice(0, 4);
        if (last4.length > 0) {
            const trailingEps = last4.reduce((sum, e) => sum + e.epsActual, 0);
            data.trailingEps = new Decimal(trailingEps.toFixed(4));

            const currentPrice = quote ? quote.close : null;
            let peRatio = null;
            if (currentPrice && trailingEps > 0) {
                peRatio = new Decimal((currentPrice / trailingEps).toFixed(4));
                data.peRatio = peRatio;
            }
            // else: omit peRatio from update — preserve any previous value.
            // The trust flag below will be false so consumers ignore it.

            data.latestEpsActual = new Decimal(withActual[0].epsActual.toFixed(4));
            data.latestEpsSurprise = withActual[0].surprisePrc != null
                ? new Decimal(withActual[0].surprisePrc.toFixed(4))
                : null;

            data.earningsTrusted = isEarningsTrustworthy(last4, peRatio);
        } else {
            logger.warn(`[SecurityMaster] ${symbol}: no past earnings with actual EPS — preserving previous values, marking earnings untrusted`);
        }
    } else {
        logger.warn(`[SecurityMaster] ${symbol}: no earnings data available — preserving previous values, marking earnings untrusted`);
    }

    // --- Dividend-derived fields ---
    if (dividends && dividends.dividends) {
        const rawDividends = dividends.dividends.filter(d => d.exDate && d.amount != null);
        const oneYearAgoMs = Date.now() - 365 * MS_PER_DAY;
        const recentDividends = rawDividends.filter(
            d => new Date(d.exDate).getTime() >= oneYearAgoMs
        );

        const annualizedDividend = recentDividends.reduce((sum, d) => sum + d.amount, 0);
        data.annualizedDividend = new Decimal(annualizedDividend.toFixed(4));

        const currentPrice = quote ? quote.close : null;
        if (annualizedDividend === 0) {
            data.dividendYield = new Decimal('0');
        } else if (currentPrice && currentPrice > 0) {
            data.dividendYield = new Decimal((annualizedDividend / currentPrice).toFixed(6));
        }
        // else: omit dividendYield — preserve previous value, mark untrusted.

        data.dividendTrusted = isDividendTrustworthy({ rawDividends, recentDividends, currentPrice });
    } else {
        logger.warn(`[SecurityMaster] ${symbol}: no dividend data available — preserving previous values, marking dividends untrusted`);
    }

    // --- Quote-derived fields ---
    if (quote) {
        if (quote.currency) data.currency = quote.currency;
        if (quote.week52High != null) data.week52High = new Decimal(quote.week52High.toFixed(4));
        if (quote.week52Low != null) data.week52Low = new Decimal(quote.week52Low.toFixed(4));
        if (quote.averageVolume != null) data.averageVolume = new Decimal(Math.round(quote.averageVolume).toString());
    }

    try {
        await prisma.securityMaster.upsert({
            where: { symbol },
            create: { symbol, ...data },
            update: data,
        });
        logger.info(`[SecurityMaster] Upserted fundamentals for ${symbol} (earningsTrusted=${data.earningsTrusted}, dividendTrusted=${data.dividendTrusted})`);
    } catch (error) {
        logger.error(`[SecurityMaster] Error upserting fundamentals for ${symbol}`, { error: error.message });
    }
}

/**
 * Get all distinct stock symbols currently held across all tenants.
 * Only includes PortfolioItems linked to a category with processingHint = 'API_STOCK'
 * and with a positive quantity (active positions).
 * Returns symbol + exchange (MIC code) so callers can disambiguate on Twelve Data.
 * @returns {Promise<Array<{symbol: string, exchange: string|null}>>}
 */
async function getAllActiveStockSymbols() {
    const items = await prisma.portfolioItem.findMany({
        where: {
            quantity: { gt: 0 },
            category: {
                processingHint: 'API_STOCK',
            },
        },
        select: { symbol: true, exchange: true },
        distinct: ['symbol'],
    });

    return items.map(i => ({ symbol: i.symbol, exchange: i.exchange || null }));
}

/**
 * Get all symbols currently in the SecurityMaster table.
 * Used for full-table refresh (as opposed to portfolio-only refresh).
 * @returns {Promise<Array<{symbol: string, exchange: string|null}>>}
 */
async function getAllSecurityMasterSymbols() {
    const records = await prisma.securityMaster.findMany({
        select: { symbol: true, exchange: true },
        orderBy: { symbol: 'asc' },
    });
    return records.map(r => ({ symbol: r.symbol, exchange: r.exchange || null }));
}

module.exports = {
    getBySymbol,
    getBySymbols,
    upsertFromProfile,
    upsertFundamentals,
    getAllActiveStockSymbols,
    getAllSecurityMasterSymbols,
};
