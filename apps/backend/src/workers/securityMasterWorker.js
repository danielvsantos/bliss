const Sentry = require('@sentry/node');
const { Worker } = require('bullmq');
const logger = require('../utils/logger');
const { getRedisConnection } = require('../utils/redis');
const { SECURITY_MASTER_QUEUE_NAME, getSecurityMasterQueue } = require('../queues/securityMasterQueue');
const prisma = require('../../prisma/prisma.js');
const securityMasterService = require('../services/securityMasterService');
const { reportWorkerFailure } = require('../utils/workerFailureReporter');
const { maybeReleaseRebuildLock } = require('../utils/rebuildLock');
const {
    getSymbolProfile,
    getEarnings,
    getDividends,
    getLatestPrice,
    getEtfComposition,
} = require('../services/twelveDataService');

const PROFILE_STALE_DAYS = 7;
/** ETF composition (#79) is refreshed on the same weekly cadence as the profile. */
const COMPOSITION_STALE_DAYS = 7;

/**
 * Credit budget math (Twelve Data Grow plan):
 *   377 credits/min shared across ALL API calls.
 *   Per symbol (with profile): 10 + 1 + 10 + 20 = 41 credits
 *   Per symbol (no profile):   1 + 10 + 20 = 31 credits
 *   Per ETF: /earnings is skipped (meaningless EPS for funds) → 21 credits (+10 profile)
 *            + /etfs/world/composition weekly (~1 credit, logged on each fetch — #79)
 *   Safe throughput: ~9 symbols/min → ~6.7s per symbol
 *
 * We enforce this by:
 *   1. Running all API calls SEQUENTIALLY (no Promise.all) so they don't
 *      blast through independent throttle queues simultaneously.
 *   2. Adding a per-symbol delay to ensure we stay under budget even when
 *      the individual throttle queues have stale slot times.
 */
const MIN_MS_PER_SYMBOL = 10000; // ~6 symbols/min × 41 credits = ~246 credits/min (safe margin under 377)

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Twelve Data expects ISO-10383 MIC codes (e.g. XNYS, BVMF, XNAS).
 * Display names like "NYSE", "NASDAQ", "BOVESPA" are NOT valid mic_code values
 * and will cause API calls to fail with "symbol is missing or invalid".
 *
 * Known display names that should NOT be passed as mic_code:
 */
const DISPLAY_NAME_EXCHANGES = new Set([
    'NYSE', 'NASDAQ', 'BOVESPA', 'AMEX', 'OTC', 'LSE', 'TSE', 'SSE', 'HKSE',
    'NSE', 'BSE', 'KRX', 'JPX', 'ASX', 'TSX', 'SIX', 'MOEX', 'SGX',
]);

/**
 * Check if a value looks like a valid MIC code vs a display name.
 * MIC codes are 4-char alphanumeric (e.g. XNYS, BVMF).
 * We reject known display names and anything longer than 4 chars.
 */
function isLikelyMicCode(exchange) {
    if (!exchange) return false;
    if (DISPLAY_NAME_EXCHANGES.has(exchange.toUpperCase())) return false;
    // MIC codes are exactly 4 alphanumeric characters
    return /^[A-Z0-9]{4}$/.test(exchange);
}

/**
 * Fetch and store an ETF's composition when it is missing or older than
 * COMPOSITION_STALE_DAYS. Returns true when a new composition was stored.
 * @param {string} symbol
 * @param {Object|null|undefined} existing Stored SecurityMaster row (undefined = not read yet)
 * @param {Object} micOpts
 */
async function refreshEtfComposition(symbol, existing, micOpts) {
    try {
        if (existing === undefined) existing = await securityMasterService.getBySymbol(symbol);
        const last = existing?.lastCompositionUpdate ? new Date(existing.lastCompositionUpdate).getTime() : 0;
        if (last && (Date.now() - last) <= COMPOSITION_STALE_DAYS * 86400000) return false;

        const composition = await getEtfComposition(symbol, micOpts);
        if (composition?.unavailable) {
            // Refused outright (e.g. endpoint not on the Twelve Data plan): wait
            // the usual 7 days instead of asking again every night.
            await securityMasterService.markEtfCompositionAttempt(symbol);
            logger.warn(`[SecurityMaster] ETF composition unavailable for ${symbol} (HTTP ${composition.status}) — retrying in ${COMPOSITION_STALE_DAYS} days`, {
                message: composition.message,
            });
            return false;
        }
        if (!composition) {
            logger.warn(`[SecurityMaster] No ETF composition for ${symbol} — keeping the previous value`);
            return false;
        }
        await securityMasterService.upsertEtfComposition(symbol, composition);
        logger.info(`[SecurityMaster] Stored ETF composition for ${symbol}`, { creditsUsed: composition.creditsUsed ?? null });
        return true;
    } catch (error) {
        logger.error(`[SecurityMaster] Error refreshing ETF composition for ${symbol}`, { error: error.message });
        return false;
    }
}

/**
 * Refresh fundamentals (and optionally profile) for a single symbol.
 * All API calls run SEQUENTIALLY to respect the shared credit budget.
 * @param {string} symbol Ticker symbol
 * @param {Object} [options]
 * @param {boolean} [options.forceProfile] Force profile refresh even if fresh
 * @param {string|null} [options.exchange] MIC code for exchange disambiguation
 * Returns an object describing what was refreshed.
 */
async function refreshSymbol(symbol, { forceProfile = false, exchange = null } = {}) {
    const result = { symbol, fundamentals: false, profile: false, error: null };
    // Only pass exchange as mic_code if it looks like a valid MIC code
    const validMic = isLikelyMicCode(exchange) ? exchange : null;
    if (exchange && !validMic) {
        logger.warn(`[SecurityMaster] Skipping invalid mic_code "${exchange}" for ${symbol} — looks like a display name`);
    }
    const micOpts = validMic ? { micCode: validMic } : {};
    const symbolStart = Date.now();

    // Check if profile needs refreshing
    let needsProfile = forceProfile;
    // Asset type decides whether /earnings is called (ETFs skip it). Taken from
    // the stored row, then overridden by a fresh profile below.
    let assetType = null;
    // Stored row (undefined = not read yet). Also used for composition staleness.
    let existing;
    if (!forceProfile) {
        try {
            existing = await securityMasterService.getBySymbol(symbol);
            assetType = existing?.assetType || null;
            if (!existing || !existing.lastProfileUpdate ||
                (Date.now() - existing.lastProfileUpdate.getTime()) > PROFILE_STALE_DAYS * 86400000) {
                needsProfile = true;
            }
        } catch (error) {
            // If we can't even read the existing row, skip the profile refresh
            // but still try fundamentals. Record the error so the caller sees it.
            result.profileError = error.message;
            logger.error(`[SecurityMaster] Error checking profile staleness for ${symbol}`, { error: error.message });
        }
    }

    // Profile refresh (if stale or forced) — 10 credits
    // Wrapped in its own try/catch so a profile failure (e.g. transient P6004
    // timeout on the upsert) does not prevent the fundamentals refresh, which
    // is the more valuable data for downstream pricing.
    if (needsProfile) {
        try {
            const profile = await getSymbolProfile(symbol, micOpts);
            if (profile) {
                if (profile.type) assetType = profile.type;
                // Pass the known MIC code so upsertFromProfile won't downgrade
                // a good MIC code to a display name when /profile lacks mic_code.
                if (exchange && !profile.micCode) {
                    profile.knownMicCode = exchange;
                }
                await securityMasterService.upsertFromProfile(symbol, profile);
                result.profile = true;

                // Self-heal: propagate correct MIC code to portfolio items that
                // may have been created with the display name (e.g. "Bovespa"
                // instead of "BVMF").
                const correctExchange = profile.micCode || exchange || null;
                if (correctExchange && correctExchange !== exchange) {
                    const { count } = await prisma.portfolioItem.updateMany({
                        where: { symbol, exchange: { not: correctExchange } },
                        data: { exchange: correctExchange },
                    });
                    if (count > 0) {
                        logger.info(`[SecurityMaster] Self-healed exchange for ${count} portfolio item(s): ${symbol} → ${correctExchange}`);
                    }
                }
            }
        } catch (error) {
            result.profileError = error.message;
            logger.error(`[SecurityMaster] Error refreshing profile for ${symbol}`, { error: error.message });
            Sentry.withScope((scope) => {
                scope.setTag('worker', 'securityMaster');
                scope.setTag('phase', 'profile');
                scope.setExtra('symbol', symbol);
                Sentry.captureException(error);
            });
        }
    }

    if (forceProfile && !result.profile) {
        // Forced profile failed — fall back to the stored type so an ETF still
        // skips /earnings.
        try {
            existing = await securityMasterService.getBySymbol(symbol);
            assetType = existing?.assetType || null;
        } catch {
            // Non-fatal: earnings will be fetched as for a stock.
        }
    }
    const isEtf = securityMasterService.isEtfAssetType(assetType);
    result.isEtf = isEtf;

    try {
        // All fundamentals calls run SEQUENTIALLY to avoid blowing
        // through independent throttle queues simultaneously.

        // Quote — 1 credit
        const quote = await getLatestPrice(symbol, { extended: true, ...micOpts });

        // Earnings — 20 credits. Skipped for ETFs: Twelve Data returns EPS-like
        // numbers for funds that would give an ETF a meaningless P/E. With
        // `earnings: null`, upsertFundamentals leaves earningsTrusted = false.
        const earnings = isEtf ? null : await getEarnings(symbol, micOpts);

        // Dividends — 20 credits
        const dividends = await getDividends(symbol, micOpts);

        await securityMasterService.upsertFundamentals(symbol, { earnings, dividends, quote, isEtf });
        result.fundamentals = true;
    } catch (error) {
        result.fundamentalsError = error.message;
        logger.error(`[SecurityMaster] Error refreshing fundamentals for ${symbol}`, { error: error.message });
        Sentry.withScope((scope) => {
            scope.setTag('worker', 'securityMaster');
            scope.setTag('phase', 'fundamentals');
            scope.setExtra('symbol', symbol);
            Sentry.captureException(error);
        });
    }

    // ETF composition (#79) — weekly, ~1 credit. Isolated: a failure keeps the
    // previous composition and never fails the symbol.
    if (isEtf) {
        result.composition = await refreshEtfComposition(symbol, existing, micOpts);
    }

    // Preserve the legacy `error` field for callers that still use it.
    // Combines both phase errors into a single message.
    if (result.profileError || result.fundamentalsError) {
        result.error = [result.profileError, result.fundamentalsError].filter(Boolean).join(' | ');
    }

    // Enforce minimum time per symbol to stay within the global credit budget.
    // This acts as a safety net on top of the per-domain throttle queues.
    const elapsed = Date.now() - symbolStart;
    if (elapsed < MIN_MS_PER_SYMBOL) {
        await sleep(MIN_MS_PER_SYMBOL - elapsed);
    }

    return result;
}

/**
 * Processes SecurityMaster refresh jobs.
 *
 * Two job types:
 * - refresh-all-fundamentals: All active stock symbols (daily cron at 3 AM UTC)
 * - refresh-single-symbol: One symbol on demand
 */
const processSecurityMasterJob = async (job) => {
    const { name, data } = job;
    const startTime = Date.now();

    logger.info(`Starting SecurityMaster job: ${name}`, { jobId: job.id, data });

    try {
        switch (name) {
            case 'refresh-single-symbol': {
                const { symbol, exchange } = data;
                if (!symbol) throw new Error('symbol is required');

                const result = await refreshSymbol(symbol, { forceProfile: true, exchange: exchange || null });
                const duration = Date.now() - startTime;

                logger.info(`[SecurityMaster] Single-symbol refresh complete: ${symbol}`, {
                    jobId: job.id, ...result, duration: `${duration}ms`,
                });
                return { success: !result.error, ...result, duration };
            }

            case 'refresh-tenant-securities': {
                // Tenant-scoped refresh (#77): new holdings (PORTFOLIO_CHANGES_PROCESSED),
                // the full-rebuild step, and Maintenance "Refresh my securities data".
                const { tenantId, force = false } = data;
                if (!tenantId) throw new Error('tenantId is required');

                const holdings = await securityMasterService.getTenantSecuritySymbols(tenantId, { force: force === true });
                logger.info(`[SecurityMaster] Tenant refresh: ${holdings.length} symbol(s) to refresh`, { tenantId, force });

                let refreshed = 0;
                let errors = 0;
                for (let i = 0; i < holdings.length; i++) {
                    const { symbol, exchange } = holdings[i];
                    const result = await refreshSymbol(symbol, { exchange });
                    if (result.fundamentals) refreshed++;
                    if (result.error) errors++;
                    await job.updateProgress(Math.round(((i + 1) / holdings.length) * 100));
                }

                const duration = Date.now() - startTime;
                logger.info('[SecurityMaster] Tenant refresh complete', {
                    jobId: job.id, tenantId, totalSymbols: holdings.length, refreshed, errors, duration: `${duration}ms`,
                });
                return { success: true, tenantId, totalSymbols: holdings.length, refreshed, errors, duration };
            }

            case 'refresh-all-fundamentals': {
                const holdings = await securityMasterService.getAllActiveSecuritySymbols();
                logger.info(`[SecurityMaster] Found ${holdings.length} active stock/ETF symbols to refresh`);

                let refreshed = 0;
                let profilesRefreshed = 0;
                let errors = 0;
                let profileErrors = 0;
                let fundamentalsErrors = 0;

                for (let i = 0; i < holdings.length; i++) {
                    const { symbol, exchange } = holdings[i];
                    const result = await refreshSymbol(symbol, { exchange });

                    if (result.fundamentals) refreshed++;
                    if (result.profile) profilesRefreshed++;
                    if (result.error) errors++;
                    if (result.profileError) profileErrors++;
                    if (result.fundamentalsError) fundamentalsErrors++;

                    logger.info(`[SecurityMaster] Refreshed ${i + 1}/${holdings.length}: ${symbol}`, {
                        exchange: exchange || undefined,
                        fundamentals: result.fundamentals,
                        profile: result.profile,
                        profileError: result.profileError || undefined,
                        fundamentalsError: result.fundamentalsError || undefined,
                    });

                    // Progress update for monitoring
                    await job.updateProgress(Math.round(((i + 1) / holdings.length) * 100));
                }

                const duration = Date.now() - startTime;
                logger.info('[SecurityMaster] Nightly refresh complete:', {
                    jobId: job.id,
                    totalSymbols: holdings.length,
                    refreshed,
                    profilesRefreshed,
                    errors,
                    profileErrors,
                    fundamentalsErrors,
                    duration: `${duration}ms`,
                });
                return { success: true, totalSymbols: holdings.length, refreshed, profilesRefreshed, errors, profileErrors, fundamentalsErrors, duration };
            }

            case 'refresh-all-from-table': {
                // Refresh all symbols in the SecurityMaster table (not just active portfolio items).
                // Useful for fixing stale data, correcting exchange MIC codes, etc.
                const allSymbols = await securityMasterService.getAllSecurityMasterSymbols();
                logger.info(`[SecurityMaster] Found ${allSymbols.length} symbols in SecurityMaster table to refresh`);

                let refreshed = 0;
                let profilesRefreshed = 0;
                let errors = 0;

                for (let i = 0; i < allSymbols.length; i++) {
                    const { symbol, exchange } = allSymbols[i];
                    const result = await refreshSymbol(symbol, { forceProfile: true, exchange });

                    if (result.fundamentals) refreshed++;
                    if (result.profile) profilesRefreshed++;
                    if (result.error) errors++;

                    logger.info(`[SecurityMaster] Table refresh ${i + 1}/${allSymbols.length}: ${symbol}`, {
                        exchange: exchange || undefined,
                        fundamentals: result.fundamentals,
                        profile: result.profile,
                        error: result.error || undefined,
                    });

                    await job.updateProgress(Math.round(((i + 1) / allSymbols.length) * 100));
                }

                const duration = Date.now() - startTime;
                logger.info('[SecurityMaster] Table refresh complete:', {
                    jobId: job.id,
                    totalSymbols: allSymbols.length,
                    refreshed,
                    profilesRefreshed,
                    errors,
                    duration: `${duration}ms`,
                });
                return { success: true, totalSymbols: allSymbols.length, refreshed, profilesRefreshed, errors, duration };
            }

            default:
                throw new Error(`Unknown SecurityMaster job name: ${name}`);
        }
    } catch (error) {
        logger.error('Error processing SecurityMaster job:', {
            jobId: job.id,
            name,
            error: error.message,
            stack: error.stack,
            duration: `${Date.now() - startTime}ms`,
        });
        throw error;
    }
};

const startSecurityMasterWorker = () => {
    logger.info('Starting SecurityMaster Worker...');

    const worker = new Worker(SECURITY_MASTER_QUEUE_NAME, processSecurityMasterJob, {
        connection: getRedisConnection(),
        concurrency: 1,
        lockDuration: 1800000, // 30 minutes — large portfolios with rate limiting
    });

    // Register the daily repeatable job (3 AM UTC — before insights at 6 AM)
    getSecurityMasterQueue().add(
        'refresh-all-fundamentals',
        {},
        {
            repeat: { pattern: '0 3 * * *' },
            jobId: 'daily-security-master-refresh',
        }
    );

    worker.on('completed', async (job) => {
        logger.info('SecurityMaster job completed:', {
            jobId: job.id,
            name: job.name,
            result: job.returnvalue,
        });
        // `refresh-tenant-securities` is the terminal job of the Maintenance
        // `security-data` rebuild scope. See `utils/rebuildLock.js`.
        await maybeReleaseRebuildLock(job);
    });

    worker.on('failed', (job, error) => {
        reportWorkerFailure({
            workerName: 'securityMaster',
            job,
            error,
            extra: { stack: error?.stack },
        });
    });

    return worker;
};

module.exports = { startSecurityMasterWorker, processSecurityMasterJob, refreshSymbol, COMPOSITION_STALE_DAYS };
