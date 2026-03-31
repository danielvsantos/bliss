const { Decimal } = require('@prisma/client/runtime/library');
const prisma = require('../../../../prisma/prisma.js');
const logger = require('../../../utils/logger');
const { normalizeTransaction } = require('../../../utils/transactionNormalizer');

/**
 * Determines if an investment transaction is a 'BUY' or 'SELL' based on cash flow.
 * @param {object} transaction The transaction to classify.
 * @returns {'BUY' | 'SELL' | 'IGNORE'} The classified action.
 */
const getTransactionAction = (transaction) => {
    // For investments, a debit is cash out (buy) and a credit is cash in (sell).
    if (transaction.debit && new Decimal(transaction.debit).isPositive()) {
        return 'BUY';
    }
    if (transaction.credit && new Decimal(transaction.credit).isPositive()) {
        return 'SELL';
    }
    return 'IGNORE';
}

/**
 * Creates a stateful, incremental holdings calculator for a single asset.
 * This is an optimization to avoid N+1 database queries inside a loop.
 * It fetches all transactions for a given asset once and then calculates
 * holdings for any given date in memory.
 *
 * @param {string} tenantId The tenant's ID.
 * @param {object} asset The asset for which to calculate holdings.
 * @param {Map<string, Decimal>} currencyRateCache A pre-filled map of currency rates.
 * @returns {Promise<{
 *   getHoldings: (date: Date) => { 
 *     quantity: Decimal, 
 *     costBasis: Decimal, 
 *     realizedPnl: Decimal, 
 *     proceeds: Decimal,
 *     costBasisInUSD: Decimal,
 *     realizedPnlInUSD: Decimal
 *   },
 *   getDatesWithTransactions: () => string[]
 *   getTransactions: () => object[]
 * }>} An object containing the holdings calculator function and a function to get transaction dates.
 */
const createIncrementalHoldingsCalculator = async (tenantId, asset, currencyRateCache) => {
    const transactions = await prisma.transaction.findMany({
        where: {
            tenantId: tenantId,
            portfolioItemId: asset.id,
            category: {
                type: { in: ['Investments', 'Debt'] }
            }
        },
        orderBy: {
            transaction_date: "asc"
        }
    })

    // --- Start Change: "First Buy" Quantity Normalization ---
    // Create a mutable copy to work with
    const processedTransactions = [...transactions]; 
    // --- End Change ---

    // A map to cache holdings calculations for specific dates to avoid re-calculation.
    const holdingsCache = new Map();
    // A map to store the running totals (quantity, cost) up to a specific date.
    const runningTotalCache = new Map();
    // A set of all dates with transactions for quick lookup.
    const datesWithTransactions = new Set(transactions.map(t => t.transaction_date.toISOString().split('T')[0]));


    // Pre-calculate running totals for each transaction date. This is the key optimization.
    // Instead of recalculating from the start for every date, we build upon the previous total.
    let runningQuantity = new Decimal(0);
    let runningCostBasis = new Decimal(0);
    let runningRealizedPnl = new Decimal(0);
    let runningProceeds = new Decimal(0);
    let runningCostBasisInUSD = new Decimal(0);
    let runningRealizedPnlInUSD = new Decimal(0);

    // --- Start Change: Handle Debt vs. Investment Logic ---
    if (asset.category.type === 'Investments') {
        for (const originalTx of processedTransactions) {
            const tx = normalizeTransaction(originalTx); // Apply normalization
            const dateStr = tx.transaction_date.toISOString().split('T')[0];
            const rateCacheKey = `${dateStr}_${asset.currency}_USD`;
            const rate = currencyRateCache.get(rateCacheKey) || new Decimal(1); // Default to 1 if not found
            
            const action = getTransactionAction(tx);
            const quantity = new Decimal(tx.assetQuantity || 0);
            let amount = new Decimal(tx.debit || tx.credit || 0);

            // Cross-currency conversion: if the transaction's currency differs from the
            // portfolio item's currency, convert the amount using USD as intermediary.
            if (tx.currency && tx.currency !== asset.currency) {
                const foreignKey = `${dateStr}_${tx.currency}_USD`;
                const itemKey = `${dateStr}_${asset.currency}_USD`;
                const foreignRate = tx.currency === 'USD' ? new Decimal(1) : (currencyRateCache.get(foreignKey) || new Decimal(1));
                const itemRate = asset.currency === 'USD' ? new Decimal(1) : (currencyRateCache.get(itemKey) || new Decimal(1));
                if (itemRate.isPositive()) {
                    amount = amount.times(foreignRate).div(itemRate);
                }
            }
            


            if (action === 'BUY') {
                runningQuantity = runningQuantity.plus(quantity);
                runningCostBasis = runningCostBasis.plus(amount);
                if (asset.currency !== 'USD') {
                    runningCostBasisInUSD = runningCostBasisInUSD.plus(amount.times(rate));
                } else {
                    runningCostBasisInUSD = runningCostBasisInUSD.plus(amount);
                }
            } else if (action === 'SELL') {
                let soldQuantity = new Decimal(tx.assetQuantity || 0).abs();
                
                // Handle unit-proxy sells: pro-rata based on withdrawal vs running cost basis.
                if (tx._isSellAll) {
                    const credit = new Decimal(tx.credit || 0);
                    if (runningCostBasis.isPositive() && credit.lt(runningCostBasis)) {
                        soldQuantity = runningQuantity.times(credit.div(runningCostBasis));
                    } else {
                        soldQuantity = runningQuantity;
                    }
                }

                // If the quantity to sell is still zero after normalization, skip this transaction
                if (soldQuantity.isZero()) {
                    logger.warn(`[HoldingsCalc] Skipping SELL transaction with zero quantity for ${asset.symbol}`, { 
                        assetId: asset.id, 
                        txId: tx.id,
                        runningQuantity: runningQuantity.toString()
                    });
                    continue;
                }

                // Validate we have something to sell
                if (runningQuantity.isZero()) {
                    logger.warn(`[HoldingsCalc] Sell transaction for ${asset.symbol} with zero quantity held.`, { 
                        assetId: asset.id, 
                        txId: tx.id 
                    });
                    continue;
                }
                const averageCost = runningCostBasis.dividedBy(runningQuantity);
                const costOfGoodsSold = averageCost.times(soldQuantity);
                
                runningRealizedPnl = runningRealizedPnl.plus(amount.minus(costOfGoodsSold));
                runningProceeds = runningProceeds.plus(amount);
                runningCostBasis = runningCostBasis.minus(costOfGoodsSold);
                runningQuantity = runningQuantity.minus(soldQuantity);

                if (asset.currency !== 'USD') {
                    const averageCostInUSD = runningCostBasisInUSD.dividedBy(runningQuantity.plus(soldQuantity)); // avg before the sale
                    const costOfGoodsSoldInUSD = averageCostInUSD.times(soldQuantity);
                    runningRealizedPnlInUSD = runningRealizedPnlInUSD.plus(amount.times(rate).minus(costOfGoodsSoldInUSD));
                    runningCostBasisInUSD = runningCostBasisInUSD.minus(costOfGoodsSoldInUSD);
                } else {
                    runningRealizedPnlInUSD = runningRealizedPnlInUSD.plus(amount.minus(costOfGoodsSold));
                    runningCostBasisInUSD = runningCostBasisInUSD.minus(costOfGoodsSold);
                }
            }

            // Store the state *after* this transaction
            runningTotalCache.set(dateStr, {
                quantity: runningQuantity,
                costBasis: runningCostBasis,
                realizedPnl: runningRealizedPnl,
                proceeds: runningProceeds,
                costBasisInUSD: runningCostBasisInUSD,
                realizedPnlInUSD: runningRealizedPnlInUSD
            });
        }
    } else if (asset.category.type === 'Debt') {
        for (const tx of processedTransactions) {
            const dateStr = tx.transaction_date.toISOString().split('T')[0];
            const rateCacheKey = `${dateStr}_${asset.currency}_USD`;
            const rate = currencyRateCache.get(rateCacheKey) || new Decimal(1);
            
            const valueChange = new Decimal(tx.credit || 0).minus(new Decimal(tx.debit || 0));
            runningCostBasis = runningCostBasis.plus(valueChange); // For debt, costBasis is the balance
            
            if (asset.currency !== 'USD') {
                runningCostBasisInUSD = runningCostBasisInUSD.plus(valueChange.times(rate));
            } else {
                runningCostBasisInUSD = runningCostBasisInUSD.plus(valueChange);
            }

            // Store the state *after* this transaction
            runningTotalCache.set(dateStr, {
                quantity: new Decimal(1), // Debt is a single unit
                costBasis: runningCostBasis,
                realizedPnl: new Decimal(0),
                proceeds: new Decimal(0),
                costBasisInUSD: runningCostBasisInUSD,
                realizedPnlInUSD: new Decimal(0)
            });
        }
    }
    // --- End Change ---

    const sortedTransactionDates = Array.from(datesWithTransactions).sort();

    /**
     * Gets the holdings for a specific date.
     * It finds the most recent state on or before the requested date and returns it.
     */
    const getHoldings = (date) => {
        const dateStr = date.toISOString().split('T')[0];

        // Fast path: If we've already calculated for this exact date, return it.
        if (holdingsCache.has(dateStr)) {
            return holdingsCache.get(dateStr);
        }
        
        // Find the latest transaction date that is on or before the requested date.
        let priorDateStr = '';
        for (let i = sortedTransactionDates.length - 1; i >= 0; i--) {
            if (sortedTransactionDates[i] <= dateStr) {
                priorDateStr = sortedTransactionDates[i];
                break;
            }
        }
        
        // If a relevant transaction state exists, use it. Otherwise, holdings are zero.
        const result = runningTotalCache.get(priorDateStr) || {
            quantity: new Decimal(0),
            costBasis: new Decimal(0),
            realizedPnl: new Decimal(0),
            proceeds: new Decimal(0),
            costBasisInUSD: new Decimal(0),
            realizedPnlInUSD: new Decimal(0)
        };

        holdingsCache.set(dateStr, result); // Cache for next time
        return result;
    };
    
    return { 
      getHoldings, 
      getDatesWithTransactions: () => sortedTransactionDates,
      getTransactions: () => transactions
    };
};

/**
 * Main processing function for investment assets.
 * It iterates through assets, calculates their daily holdings, and saves the history.
 * @param {object} job The BullMQ job object.
 */
const processInvestmentValuation = async (job) => {
    const { tenantId, assets } = job.data;
    if (!assets || assets.length === 0) {
        logger.info('[HoldingsCalc] No investment assets provided to process.');
        return { success: true, processed: 0 };
    }

    logger.info(`--- Starting Investment Valuation for tenant ${tenantId} on ${assets.length} asset(s) ---`);

    for (const asset of assets) {
        try {
            const holdingsCalculator = await createIncrementalHoldingsCalculator(tenantId, asset);
            const transactionDates = holdingsCalculator.getDatesWithTransactions();

            if (transactionDates.length === 0) {
                logger.info(`[HoldingsCalc] No transactions found for asset ${asset.symbol}. Skipping.`);
                continue;
            }

            const holdingsToCreate = [];
            const today = new Date();
            today.setUTCHours(0, 0, 0, 0);
            const firstDate = new Date(transactionDates[0]);

            // Use a while loop with UTC dates to safely iterate across days and avoid DST issues.
            let currentDateIterator = new Date(Date.UTC(firstDate.getUTCFullYear(), firstDate.getUTCMonth(), firstDate.getUTCDate()));

            while (currentDateIterator <= today) {
                const currentDate = new Date(currentDateIterator); // Use a non-mutated copy for processing
                const { quantity, costBasis } = holdingsCalculator.getHoldings(currentDate);
                const totalValue = quantity.times(asset.currentPrice || 0); // Assuming currentPrice is available

                holdingsToCreate.push({
                    portfolioItemId: asset.id,
                    date: currentDate,
                    quantity,
                    costBasis,
                    totalValue,
                });

                // Safely advance to the next UTC day
                currentDateIterator.setUTCDate(currentDateIterator.getUTCDate() + 1);
            }

            if (holdingsToCreate.length > 0) {
                try {
                    await prisma.portfolioHolding.createMany({
                        data: holdingsToCreate,
                        skipDuplicates: true,
                    });
                } catch (dbError) {
                    logger.error(`[HoldingsCalc] Failed to bulk create portfolio holdings for asset ${asset.symbol}.`, {
                        tenantId,
                        assetId: asset.id,
                        recordsAttempted: holdingsToCreate.length,
                        prismaError: dbError.message,
                    });
                    // Continue to the next asset instead of crashing the whole job
                    continue;
                }
            }

            // Update the master PortfolioItem with the final state
            const finalHoldings = holdingsCalculator.getHoldings(today);
            await prisma.portfolioItem.update({
                where: { id: asset.id },
                data: {
                    quantity: finalHoldings.quantity,
                    costBasis: finalHoldings.costBasis,
                    realizedPnL: finalHoldings.realizedPnl,
                    updatedAt: new Date()
                }
            });
        } catch (error) {
            logger.error(`[HoldingsCalc] Error processing asset ${asset.symbol}: ${error.message}`, {
                tenantId,
                assetId: asset.id,
                stack: error.stack,
            });
        }
    }
    logger.info(`--- Finished Investment Valuation for tenant ${tenantId}. ---`);
    return { success: true, processed: assets.length };
};


module.exports = { createIncrementalHoldingsCalculator };