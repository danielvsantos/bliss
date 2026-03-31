import prisma from '../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import { cors } from '../../../utils/cors.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import * as Sentry from '@sentry/nextjs';
import { calculateAssetCurrentValue } from '../../../services/valuation.service.js';
import { Decimal } from '@prisma/client/runtime/library';
import { withAuth } from '../../../utils/withAuth.js';
import { convertCurrency } from '../../../utils/currencyConversion.js';

export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.portfolio(req, res, (result) => {
      if (result instanceof Error) {
        return reject(result);
      }
      return resolve(result);
    });
  });

  if (cors(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  try {
    const { assetType, source, include_manual_values } = req.query;

    // Fetch tenant's portfolio currency
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: { portfolioCurrency: true },
    });
    const portfolioCurrency = tenant?.portfolioCurrency || 'USD';

    const filters = {
      tenantId: req.user.tenantId,
      ...(source && { source }),
      category: {
        type: assetType ? assetType : { in: ['Investments', 'Asset', 'Debt'] },
      },
    };

    const selectClause = {
      id: true,
      symbol: true,
      source: true,
      currency: true,
      exchange: true,
      assetCurrency: true,
      quantity: true,
      costBasis: true,
      realizedPnL: true,
      currentValue: true,
      totalInvested: true,
      costBasisInUSD: true,
      currentValueInUSD: true,
      realizedPnLInUSD: true,
      totalInvestedInUSD: true,
      category: {
        select: {
          name: true,
          group: true,
          type: true,
          icon: true,
          processingHint: true,
        },
      },
    };

    if (include_manual_values === 'true') {
      selectClause.manualValues = {
        orderBy: {
          date: 'desc',
        },
        take: 1,
      };
    }

    selectClause.debtTerms = true;

    const assetsFromDb = await prisma.portfolioItem.findMany({
      where: filters,
      select: selectClause,
      orderBy: { symbol: 'asc' },
    });

    const enrichedAssets = await Promise.all(
      assetsFromDb.map(async (asset) => {
        const quantity = new Decimal(asset.quantity || 0);
        const hint = asset.category?.processingHint;

        // Start with the pre-calculated values from the database
        let marketValueNative = new Decimal(asset.currentValue || 0);
        let marketValueUSD = new Decimal(asset.currentValueInUSD || 0);

        // For certain assets, fetch a live price to override the stored value.
        // The price returned by calculateAssetCurrentValue is in the asset's trading
        // currency (assetCurrency), which may differ from the account currency.
        // If the live price fetch fails or returns zero, keep the stored values from the DB.
        if ((hint === 'API_STOCK' || hint === 'API_CRYPTO' || hint === 'API_FUND') && quantity > 0 && asset.source !== 'MANUAL') {
          const livePricePerUnit = await calculateAssetCurrentValue(asset);

          // Only override stored values if we got a meaningful live price.
          // When the API fails (e.g., unresolvable ticker), the fallback returns 0 or cost-basis —
          // in that case, the pre-calculated currentValue/currentValueInUSD from the valuation
          // worker is more accurate (it includes cost-basis fallback with proper currency conversions).
          if (livePricePerUnit && livePricePerUnit.gt(0)) {
            const priceCurrency = asset.assetCurrency || asset.currency;
            const marketValueInPriceCurrency = livePricePerUnit.times(quantity);

            // Convert to account currency (native block)
            if (priceCurrency !== asset.currency) {
              const convertedNative = await convertCurrency(marketValueInPriceCurrency, priceCurrency, asset.currency);
              marketValueNative = convertedNative || marketValueInPriceCurrency;
            } else {
              marketValueNative = marketValueInPriceCurrency;
            }

            // Convert to USD — go directly from price currency to avoid double-conversion
            if (priceCurrency === 'USD') {
              marketValueUSD = marketValueInPriceCurrency;
            } else {
              const convertedUSD = await convertCurrency(marketValueInPriceCurrency, priceCurrency, 'USD');
              marketValueUSD = convertedUSD || marketValueInPriceCurrency;
            }
          }
        }

        const costBasisNative = new Decimal(asset.costBasis || 0);
        const unrealizedPnLNative = marketValueNative.minus(costBasisNative);
        const unrealizedPnLPercentNative = costBasisNative.isZero() ? new Decimal(0) : unrealizedPnLNative.dividedBy(costBasisNative).times(100);

        const costBasisUSD = new Decimal(asset.costBasisInUSD || 0);
        const unrealizedPnLUSD = marketValueUSD.minus(costBasisUSD);
        const unrealizedPnLPercentUSD = costBasisUSD.isZero() ? new Decimal(0) : unrealizedPnLUSD.dividedBy(costBasisUSD).times(100);

        // Portfolio currency block — convert from USD to tenant's portfolio currency
        let portfolioBlock = null;
        if (portfolioCurrency !== 'USD') {
          const costBasisPC = await convertCurrency(costBasisUSD, 'USD', portfolioCurrency);
          const marketValuePC = await convertCurrency(marketValueUSD, 'USD', portfolioCurrency);
          const realizedPnLPC = await convertCurrency(new Decimal(asset.realizedPnLInUSD || 0), 'USD', portfolioCurrency);
          const totalInvestedPC = await convertCurrency(new Decimal(asset.totalInvestedInUSD || 0), 'USD', portfolioCurrency);

          if (costBasisPC && marketValuePC) {
            const unrealizedPnLPC = marketValuePC.minus(costBasisPC);
            const unrealizedPnLPercentPC = costBasisPC.isZero() ? new Decimal(0) : unrealizedPnLPC.dividedBy(costBasisPC).times(100);

            portfolioBlock = {
              costBasis: costBasisPC,
              marketValue: marketValuePC,
              unrealizedPnL: unrealizedPnLPC,
              unrealizedPnLPercent: unrealizedPnLPercentPC,
              realizedPnL: realizedPnLPC || new Decimal(0),
              totalInvested: totalInvestedPC || new Decimal(0),
            };
          }
        }

        // Construct the response
        const response = {
          id: asset.id,
          symbol: asset.symbol,
          currency: asset.currency,
          quantity: quantity,
          category: {
            name: asset.category.name,
            group: asset.category.group,
            type: asset.category.type,
            icon: asset.category.icon,
            processingHint: asset.category.processingHint,
          },
          native: {
            costBasis: costBasisNative,
            marketValue: marketValueNative,
            unrealizedPnL: unrealizedPnLNative,
            unrealizedPnLPercent: unrealizedPnLPercentNative,
            realizedPnL: new Decimal(asset.realizedPnL || 0),
            totalInvested: new Decimal(asset.totalInvested || 0),
          },
          usd: {
            costBasis: costBasisUSD,
            marketValue: marketValueUSD,
            unrealizedPnL: unrealizedPnLUSD,
            unrealizedPnLPercent: unrealizedPnLPercentUSD,
            realizedPnL: new Decimal(asset.realizedPnLInUSD || 0),
            totalInvested: new Decimal(asset.totalInvestedInUSD || 0),
          },
        };

        // Add portfolio currency block (only when different from USD)
        if (portfolioBlock) {
          response.portfolio = portfolioBlock;
        }

        if (asset.manualValues) {
          response.manualValues = asset.manualValues;
        }

        if (asset.debtTerms) {
          response.debtTerms = asset.debtTerms;
        }

        return response;
      })
    );

    res.status(StatusCodes.OK).json({
      portfolioCurrency,
      items: enrichedAssets,
    });
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
