import prisma from '../prisma/prisma.js';
import { Decimal } from '@prisma/client/runtime/library';
import axios from 'axios';
import * as Sentry from '@sentry/nextjs';

const backendApiUrl = process.env.BACKEND_URL || 'http://localhost:3001';
const apiKey = process.env.INTERNAL_API_KEY;

// Upper bound for the backend price lookup. The backend may itself wait on the
// market-data provider's rate limiter (one call every 200 ms), so a cold-cache
// load of ~100 symbols needs ~20 s for the tail; a page load must still never
// hang on it indefinitely.
const PRICE_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Calculates the current market value of a single asset.
 * This function is the primary point of contact for valuation.
 * @param {object} asset - The PortfolioItem object from Prisma.
 * @returns {Promise<Decimal|null>} The current market value of one unit of the
 *   asset, or null when no live price could be fetched (timeout, 404, 5xx,
 *   network error). Callers keep the stored valuation on null — never
 *   substitute cost basis, which would overwrite last night's value.
 */
async function calculateAssetCurrentValue(asset) {
    if (!asset) return null;

    // For cash, the value is always 1 — no pricing request. The default cash
    // category is type 'Asset' / group 'Cash', so match on processingHint.
    if (asset.category?.processingHint === 'CASH' || asset.category?.type === 'Cash') {
        return new Decimal(1);
    }

    try {
        const url = new URL('/api/pricing/prices', backendApiUrl);
        url.searchParams.append('symbol', asset.symbol);
        url.searchParams.append('assetType', asset.category?.processingHint);
        // For crypto, the price pair depends on the account currency (e.g. BTC/EUR).
        // Fall back to asset.currency (account currency) when assetCurrency is not set.
        // For stocks/funds, currency is ignored by the backend — safe to always send.
        const priceCurrency = asset.assetCurrency || asset.currency;
        if (priceCurrency) {
            url.searchParams.append('currency', priceCurrency);
        }
        if (asset.exchange) {
            url.searchParams.append('exchange', asset.exchange);
        }

        const response = await axios.get(url.toString(), {
            headers: { 'x-api-key': apiKey },
            timeout: PRICE_REQUEST_TIMEOUT_MS,
        });

        if (response.data && response.data.price) {
            return new Decimal(response.data.price);
        }
    } catch (error) {
        if (error.response?.status === 404) {
            // 404 is the backend's "no live price and no stored price" answer —
            // expected for unpriceable symbols (pre-IPO, delisted, MANUAL assets).
            console.info(`[ValuationService] No price available for ${asset.symbol}; keeping stored value.`);
            Sentry.addBreadcrumb({
                category: 'valuation',
                level: 'info',
                message: `No price available for ${asset.symbol}; keeping stored value.`,
                data: { assetId: asset.id },
            });
        } else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
            // Timeouts are an expected result of the backend's provider throttle
            // on a cold cache: warn, no Sentry event.
            console.warn(`[ValuationService] Price fetch for ${asset.symbol} timed out after ${PRICE_REQUEST_TIMEOUT_MS}ms; keeping stored value.`);
        } else {
            // 5xx and network errors are real failures.
            const detail = error.response
                ? `HTTP ${error.response.status}`
                : error.code || error.message || 'unknown error';
            console.error(`[ValuationService] Failed to fetch price for ${asset.symbol} from ${backendApiUrl}. Error: ${detail}`);
            Sentry.captureException(error, {
                extra: {
                    message: `[ValuationService] Failed to fetch price for ${asset.symbol} from backend service.`,
                    assetId: asset.id
                }
            });
        }
    }

    return null;
}

export {
    calculateAssetCurrentValue,
};