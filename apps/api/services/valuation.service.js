import prisma from '../prisma/prisma.js';
import { Decimal } from '@prisma/client/runtime/library';
import axios from 'axios';
import * as Sentry from '@sentry/nextjs';

const backendApiUrl = process.env.BACKEND_URL || 'http://localhost:3001';
const apiKey = process.env.INTERNAL_API_KEY;

// Upper bound for the backend price lookup. The backend may itself wait on the
// market-data provider's rate limiter, but a page load must never hang on it.
const PRICE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Calculates the current market value of a single asset.
 * This function is the primary point of contact for valuation.
 * @param {object} asset - The PortfolioItem object from Prisma.
 * @returns {Promise<Decimal>} The current market value of one unit of the asset.
 */
async function calculateAssetCurrentValue(asset) {
    if (!asset) return new Decimal(0);

    // For cash, the value is always 1.
    if (asset.category?.type === 'Cash') {
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
        // 404 is the backend's "no live price and no stored price" answer —
        // expected for unpriceable symbols (pre-IPO, delisted, MANUAL assets).
        // It is not an error: fall back to cost basis without alerting.
        // 5xx, network errors and timeouts still go to Sentry below.
        if (error.response?.status === 404) {
            console.info(`[ValuationService] No price available for ${asset.symbol}; using cost basis.`);
            Sentry.addBreadcrumb({
                category: 'valuation',
                level: 'info',
                message: `No price available for ${asset.symbol}; using cost basis.`,
                data: { assetId: asset.id },
            });
        } else {
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
    
    // Cost-basis fallback is an expected state (pre-IPO, MANUAL assets, market closures).
    // Real errors (backend 5xx, unreachable, timeout) are captured above via Sentry.captureException.
    const quantity = asset.quantity || asset.holdings?.[0]?.quantity || 1;
    return new Decimal(asset.costBasis || 0).dividedBy(quantity);
}

export {
    calculateAssetCurrentValue,
};