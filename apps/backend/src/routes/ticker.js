const express = require('express');
const router = express.Router();
const apiKeyAuth = require('../middleware/apiKeyAuth');
const twelveDataService = require('../services/twelveDataService');
const securityMasterService = require('../services/securityMasterService');
const { searchCrypto } = require('../services/cryptoService');
const logger = require('../utils/logger');

const PROFILE_CACHE_TTL_DAYS = 7;

/**
 * GET /api/ticker/search
 *
 * Internal endpoint: searches for symbols matching a query.
 * Routes to Twelve Data for all asset types. When type=crypto, results are
 * filtered and deduplicated to return base crypto symbols (e.g. BTC, not BTC/USD).
 *
 * Query params:
 *   ?q=<string>      — Search term (required), e.g. 'VWCE', 'Apple', 'BTC'
 *   ?type=<string>   — Optional: 'crypto' filters for digital currency results
 *
 * Returns: { results: [{ symbol, name, exchange, country, currency, type, mic_code }] }
 */
router.get('/search', apiKeyAuth, async (req, res) => {
    const { q, type } = req.query;

    if (!q || typeof q !== 'string' || !q.trim()) {
        return res.status(400).json({ error: 'q query parameter is required' });
    }

    try {
        let results;

        if (type === 'crypto') {
            results = await searchCrypto(q.trim());
        } else {
            results = await twelveDataService.searchSymbol(q.trim());
        }

        logger.info(`Ticker search for "${q}" (type=${type || 'stock'}): ${results.length} results`);
        res.status(200).json({ results });
    } catch (error) {
        logger.error(`Ticker search failed for "${q}": ${error.message}`);
        res.status(500).json({ error: 'Failed to search symbols' });
    }
});

/**
 * GET /api/ticker/profile
 *
 * Internal endpoint: fetches the profile (ISIN, exchange, currency) for a symbol.
 *
 * Query params:
 *   ?symbol=<string>  — Ticker symbol (required)
 *
 * Returns: { isin, exchange, name, currency, sector, type }
 */
router.get('/profile', apiKeyAuth, async (req, res) => {
    const { symbol, exchange } = req.query;

    if (!symbol || typeof symbol !== 'string' || !symbol.trim()) {
        return res.status(400).json({ error: 'symbol query parameter is required' });
    }

    const trimmed = symbol.trim();
    const micCode = exchange && typeof exchange === 'string' ? exchange.trim() : undefined;

    try {
        // Cache-first: check SecurityMaster before calling Twelve Data
        const cached = await securityMasterService.getBySymbol(trimmed);
        if (cached && cached.lastProfileUpdate) {
            const ageMs = Date.now() - new Date(cached.lastProfileUpdate).getTime();
            const ageDays = ageMs / (1000 * 60 * 60 * 24);
            if (ageDays < PROFILE_CACHE_TTL_DAYS) {
                logger.info(`Ticker profile for "${trimmed}" served from SecurityMaster cache (${ageDays.toFixed(1)}d old)`);
                return res.status(200).json({
                    isin: cached.isin,
                    exchange: cached.exchange,
                    name: cached.name,
                    currency: cached.currency,
                    sector: cached.sector,
                    type: cached.assetType,
                    industry: cached.industry,
                    country: cached.country,
                    description: cached.description,
                    logoUrl: cached.logoUrl,
                    ceo: cached.ceo,
                    employees: cached.employees,
                    website: cached.website,
                });
            }
        }

        // Cache miss or stale — fetch from Twelve Data (pass micCode for disambiguation)
        const profile = await twelveDataService.getSymbolProfile(trimmed, { micCode });

        if (!profile) {
            return res.status(404).json({ error: `No profile found for symbol: ${symbol}` });
        }

        // Pass the caller's MIC code so it's preserved in SecurityMaster
        // even if /profile doesn't return mic_code in its response.
        if (micCode && !profile.micCode) {
            profile.knownMicCode = micCode;
        }

        // Fire-and-forget: populate SecurityMaster cache
        securityMasterService.upsertFromProfile(trimmed, profile).catch(err => {
            logger.error(`[Ticker] Failed to cache profile for ${trimmed}`, { error: err.message });
        });

        logger.info(`Ticker profile for "${trimmed}": ${profile.name}`);
        res.status(200).json(profile);
    } catch (error) {
        logger.error(`Ticker profile failed for "${trimmed}": ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch symbol profile' });
    }
});

module.exports = router;
