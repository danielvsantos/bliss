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

/**
 * Compute and upsert fundamental fields from earnings, dividends, and quote data.
 *
 * Computation logic:
 * - trailingEps: sum of last 4 quarters eps_actual (skipping nulls)
 * - peRatio: currentPrice / trailingEps (null if trailingEps <= 0 or no price)
 * - annualizedDividend: sum of dividends with ex_date in last 12 months
 * - dividendYield: annualizedDividend / currentPrice (null if no price)
 * - latestEpsActual: most recent non-null eps_actual
 * - latestEpsSurprise: corresponding surprise_prc
 * - week52High/Low/averageVolume: from extended quote data
 *
 * @param {string} symbol
 * @param {Object} params
 * @param {Object|null} params.earnings — From twelveDataService.getEarnings()
 * @param {Object|null} params.dividends — From twelveDataService.getDividends()
 * @param {Object|null} params.quote — From twelveDataService.getLatestPrice({ extended: true })
 */
async function upsertFundamentals(symbol, { earnings, dividends, quote }) {
    const data = { lastFundamentalsUpdate: new Date() };

    // --- Earnings-derived fields ---
    if (earnings && earnings.earnings && earnings.earnings.length > 0) {
        // Filter to records with a valid numeric epsActual (not null, NaN, or upcoming)
        // Also exclude future-dated records as a safety net (API layer already filters these)
        const todayStr = new Date().toISOString().split('T')[0];
        const withActual = earnings.earnings.filter(e =>
            e.epsActual != null && Number.isFinite(e.epsActual) &&
            e.date && e.date <= todayStr
        );
        logger.info(`[SecurityMaster] ${symbol}: ${earnings.earnings.length} earnings records, ${withActual.length} with actual EPS (past dates only)`);

        // Trailing EPS: sum of last 4 quarters
        const last4 = withActual.slice(0, 4);
        if (last4.length > 0) {
            const trailingEps = last4.reduce((sum, e) => sum + e.epsActual, 0);
            data.trailingEps = new Decimal(trailingEps.toFixed(4));

            // P/E ratio: currentPrice / trailingEps
            const currentPrice = quote ? quote.close : null;
            if (currentPrice && trailingEps > 0) {
                data.peRatio = new Decimal((currentPrice / trailingEps).toFixed(4));
            } else {
                data.peRatio = null;
            }
        }

        // Latest EPS actual and surprise
        if (withActual.length > 0) {
            data.latestEpsActual = new Decimal(withActual[0].epsActual.toFixed(4));
            data.latestEpsSurprise = withActual[0].surprisePrc != null
                ? new Decimal(withActual[0].surprisePrc.toFixed(4))
                : null;
        }
    }

    // --- Dividend-derived fields ---
    if (dividends && dividends.dividends && dividends.dividends.length > 0) {
        // Sum dividends with ex_date in the last 12 months
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

        const recentDividends = dividends.dividends.filter(d => {
            if (!d.exDate || d.amount == null) return false;
            return new Date(d.exDate) >= oneYearAgo;
        });

        const annualizedDividend = recentDividends.reduce((sum, d) => sum + d.amount, 0);
        data.annualizedDividend = new Decimal(annualizedDividend.toFixed(4));

        // Dividend yield: annualizedDividend / currentPrice
        const currentPrice = quote ? quote.close : null;
        if (currentPrice && currentPrice > 0 && annualizedDividend > 0) {
            data.dividendYield = new Decimal((annualizedDividend / currentPrice).toFixed(6));
        } else {
            data.dividendYield = annualizedDividend > 0 ? null : new Decimal('0');
        }
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
        logger.info(`[SecurityMaster] Upserted fundamentals for ${symbol}`);
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
