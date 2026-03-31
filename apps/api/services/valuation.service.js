import prisma from '../prisma/prisma.js';
import { Decimal } from '@prisma/client/runtime/library';
import axios from 'axios';
import * as Sentry from '@sentry/nextjs';

const backendApiUrl = process.env.INTERNAL_BACKEND_API_URL || 'http://localhost:3001';
const apiKey = process.env.INTERNAL_API_KEY;

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
        });

        if (response.data && response.data.price) {
            return new Decimal(response.data.price);
        }
    } catch (error) {
        console.error(`[ValuationService] Failed to fetch price for ${asset.symbol}. Error: ${error.message}`);
        Sentry.captureException(error, {
            extra: {
                message: `[ValuationService] Failed to fetch price for ${asset.symbol} from backend service.`,
                assetId: asset.id
            }
        });
    }
    
    // Fallback logic if API fails or returns no price
    Sentry.captureMessage(`[ValuationService] Falling back to cost basis for ${asset.symbol}`, {
        level: 'warning',
        extra: { assetId: asset.id }
    });
    const quantity = asset.quantity || asset.holdings?.[0]?.quantity || 1;
    return new Decimal(asset.costBasis || 0).dividedBy(quantity);
}

export {
    calculateAssetCurrentValue,
};