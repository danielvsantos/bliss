const { Decimal } = require('@prisma/client/runtime/library');
const { normalizeTransaction, isBuyTransaction } = require('./transactionNormalizer');
const { getRatesForDateRange } = require('../services/currencyService');


/**
 * Calculates the total invested amount for an asset based on its transactions.
 * This is the sum of all debit transactions, representing "buy" actions.
 * @param {Array<object>} transactions An array of transaction objects.
 * @returns {Decimal} The total invested amount.
 */
function calculateTotalInvested(transactions) {
  if (!transactions || transactions.length === 0) {
    return new Decimal(0);
  }
  return transactions
    .filter(tx => tx.debit && new Decimal(tx.debit).gt(0)) // Filter for "buy" transactions
    .reduce((sum, tx) => sum.plus(new Decimal(tx.debit)), new Decimal(0));
}

/**
 * Calculates the final state (cost basis, realized PnL) for an investment item
 * by processing its transactions in-memory using FIFO logic.
 * @param {Array<object>} transactions - The transactions for the investment item.
 * @returns {{costBasis: Decimal, realizedPnL: Decimal}} The final calculated state.
 */
function calculateInvestmentState(transactions) {
    const lots = []; // In-memory representation of lots
    let realizedPnL = new Decimal(0);
    let totalQuantity = new Decimal(0);

    for (const originalTx of transactions) {
        const tx = normalizeTransaction(originalTx); // Normalize the transaction
        const isBuy = isBuyTransaction(tx);
        const isSell = tx.credit && new Decimal(tx.credit).gt(0);

        if (isBuy) {
            // Default assetQuantity to 1 for buy transactions — handles manually-tracked funds
            // where only the debit (total amount) is recorded without unit information.
            // Each deposit becomes "1 unit worth the full debit amount".
            totalQuantity = totalQuantity.plus(tx.assetQuantity || 1);

            let price = new Decimal(0);
            const quantity = new Decimal(tx.assetQuantity || 1);
            if (!quantity.isZero()) {
                const assetPrice = new Decimal(tx.assetPrice || 0);
                if (assetPrice.gt(0)) {
                    price = assetPrice;
                } else {
                    price = new Decimal(tx.debit).div(quantity);
                }
            }

            lots.push({
                quantity,
                price,
            });
        } else if (isSell) { // A "sell" or transfer out
            let quantityToSell = new Decimal(tx.assetQuantity || 0).abs();
            
            // Handle unit-proxy sells (marked by normalizer with _isSellAll flag).
            // Pro-rata: sell a proportion of units matching the withdrawal vs current cost basis.
            // This correctly handles multiple partial withdrawals from pension plans, funds, etc.
            if (tx._isSellAll) {
                const currentCostBasis = lots.reduce(
                    (sum, lot) => sum.plus(lot.quantity.times(lot.price)),
                    new Decimal(0)
                );
                const credit = new Decimal(tx.credit);
                if (currentCostBasis.isPositive() && credit.lt(currentCostBasis)) {
                    quantityToSell = totalQuantity.times(credit.div(currentCostBasis));
                } else {
                    // Fallback: close entire position (credit >= costBasis or costBasis <= 0)
                    quantityToSell = totalQuantity;
                }
            }
            
            if (quantityToSell.isZero() || !tx.credit) continue;

            totalQuantity = totalQuantity.minus(quantityToSell);

            const salePrice = new Decimal(tx.credit).div(quantityToSell);
            const remainingLots = [];

            for (const lot of lots) {
                if (quantityToSell.isZero()) {
                    remainingLots.push(lot);
                    continue;
                }

                const quantityFromThisLot = Decimal.min(quantityToSell, lot.quantity);
                const costOfPortion = lot.price.times(quantityFromThisLot);
                const proceedsFromPortion = salePrice.times(quantityFromThisLot);
                realizedPnL = realizedPnL.plus(proceedsFromPortion.minus(costOfPortion));

                const remainingInLot = lot.quantity.minus(quantityFromThisLot);
                if (remainingInLot.gt(0)) {
                    remainingLots.push({ ...lot, quantity: remainingInLot });
                }
                quantityToSell = quantityToSell.minus(quantityFromThisLot);
            }
            // Clear the lots array and repopulate with the ones that still have quantity
            lots.length = 0; 
            lots.push(...remainingLots);
        }
    }

    const costBasis = lots.reduce((sum, lot) => {
        return sum.plus(lot.quantity.times(lot.price));
    }, new Decimal(0));
    
    return { costBasis, realizedPnL, quantity: totalQuantity };
}

/**
 * Calculates the final state for a debt item.
 * @param {Array<object>} transactions - The transactions for the debt item.
 * @returns {{costBasis: Decimal, realizedPnL: Decimal}} The final calculated state.
 */
function calculateDebtState(transactions) {
    // For debt, cost basis is simply the current balance.
    const balance = transactions.reduce((sum, tx) => {
        const valueChange = new Decimal(tx.debit || 0).minus(new Decimal(tx.credit || 0));
        return sum.plus(valueChange);
    }, new Decimal(0));

    return {
        costBasis: balance,
        realizedPnL: new Decimal(0) // Debt does not have realized PnL.
    };
}

/**
 * A comprehensive, centralized function to calculate the complete initial state 
 * of a portfolio item from its transactions, including all USD conversions.
 *
 * @param {Array<object>} transactions - The transactions for the portfolio item, sorted by date.
 * @param {Map<string, Decimal>=} currencyRateCache - Optional pre-fetched cache of currency rates.
 * @returns {Promise<object>} A promise that resolves to the complete state object.
 */
const calculatePortfolioItemState = async (transactions, currencyRateCache = new Map()) => {
    if (!transactions || transactions.length === 0) {
        return {};
    }

    const itemType = transactions[0].category?.type;
    const currency = transactions[0].currency;
    const state = {};

    // --- 1. Pre-fetch all necessary currency rates if not provided ---
    const earliestDate = new Date(transactions[0].transaction_date);
    const latestDate = new Date(transactions[transactions.length - 1].transaction_date);

    // Detect foreign currencies (transactions with a different currency than the portfolio item)
    const foreignCurrencies = [...new Set(
        transactions.filter(tx => tx.currency && tx.currency !== currency).map(tx => tx.currency)
    )];

    if (currencyRateCache.size === 0) {
        // Fetch item currency → USD rates (needed for USD conversions)
        if (currency !== 'USD') {
            const ratesMap = await getRatesForDateRange(earliestDate, latestDate, currency, 'USD');
            for (const [dateStr, rate] of ratesMap.entries()) {
                currencyRateCache.set(`${dateStr}_${currency}_USD`, rate);
            }
        }
        // Fetch foreign currency → USD rates (needed for cross-currency conversion)
        for (const foreignCurrency of foreignCurrencies) {
            if (foreignCurrency === 'USD') continue; // USD rate is always 1
            const ratesMap = await getRatesForDateRange(earliestDate, latestDate, foreignCurrency, 'USD');
            for (const [dateStr, rate] of ratesMap.entries()) {
                currencyRateCache.set(`${dateStr}_${foreignCurrency}_USD`, rate);
            }
        }
    }

    // Get the item currency → USD rate for a given date
    const getRate = (date) => {
        if (currency === 'USD') return new Decimal(1);
        const dateStr = date.toISOString().slice(0, 10);
        const cacheKey = `${dateStr}_${currency}_USD`;
        return currencyRateCache.get(cacheKey) || new Decimal(1);
    };

    // Convert a foreign-currency transaction's amounts to the item's currency.
    // Uses USD as the intermediary: foreignCurrency→itemCurrency = foreign→USD / item→USD
    const convertToItemCurrency = (tx) => {
        if (!tx.currency || tx.currency === currency) return tx;
        const dateStr = tx.transaction_date.toISOString().slice(0, 10);
        const foreignRate = tx.currency === 'USD'
            ? new Decimal(1)
            : (currencyRateCache.get(`${dateStr}_${tx.currency}_USD`) || new Decimal(1));
        const itemRate = currency === 'USD'
            ? new Decimal(1)
            : (currencyRateCache.get(`${dateStr}_${currency}_USD`) || new Decimal(1));
        const crossRate = itemRate.isPositive() ? foreignRate.div(itemRate) : new Decimal(1);

        return {
            ...tx,
            currency, // Mark as converted
            debit: tx.debit ? new Decimal(tx.debit).times(crossRate).toNumber() : tx.debit,
            credit: tx.credit ? new Decimal(tx.credit).times(crossRate).toNumber() : tx.credit,
            // Recalculate assetPrice if quantity is explicit (price is in the foreign currency)
            assetPrice: (tx.assetPrice && tx.assetQuantity)
                ? new Decimal(tx.assetPrice).times(crossRate).toNumber()
                : tx.assetPrice,
        };
    };

    // --- 1b. Convert foreign-currency transactions to the item's currency ---
    const convertedTransactions = foreignCurrencies.length > 0
        ? transactions.map(convertToItemCurrency)
        : transactions;

    // --- 2. Calculate state based on item type ---
    if (itemType === 'Investments') {
        const { costBasis, realizedPnL, quantity } = calculateInvestmentState(convertedTransactions);
        state.costBasis = costBasis;
        state.realizedPnL = realizedPnL;
        state.quantity = quantity;
        state.totalInvested = calculateTotalInvested(convertedTransactions);
        
        // Calculate USD equivalents using proper FIFO with historical rates
        let realizedPnLInUSD = new Decimal(0);
        let totalInvestedInUSD = new Decimal(0);
        let totalQuantityUSD = new Decimal(0);
        const lotsUSD = [];

        for (const originalTx of convertedTransactions) {
            const tx = normalizeTransaction(originalTx);
            const isBuy = isBuyTransaction(tx);
            const isSell = tx.credit && new Decimal(tx.credit).gt(0);

            if (isBuy) {
                const rate = getRate(tx.transaction_date);
                const amount = new Decimal(tx.debit || 0);
                const qty = new Decimal(tx.assetQuantity || 1);
                totalInvestedInUSD = totalInvestedInUSD.plus(amount.times(rate));
                totalQuantityUSD = totalQuantityUSD.plus(qty);
                if (!qty.isZero()) {
                    lotsUSD.push({ quantity: qty, price: amount.div(qty), rate });
                }
            } else if (isSell) {
                const sellRate = getRate(tx.transaction_date);
                let quantityToSell = new Decimal(tx.assetQuantity || 0).abs();

                if (tx._isSellAll) {
                    // Pro-rata: lotsUSD stores price in original currency (matches tx.credit)
                    const currentCostBasis = lotsUSD.reduce(
                        (sum, lot) => sum.plus(lot.quantity.times(lot.price)),
                        new Decimal(0)
                    );
                    const credit = new Decimal(tx.credit);
                    if (currentCostBasis.isPositive() && credit.lt(currentCostBasis)) {
                        quantityToSell = totalQuantityUSD.times(credit.div(currentCostBasis));
                    } else {
                        quantityToSell = totalQuantityUSD;
                    }
                }

                if (quantityToSell.isZero() || !tx.credit) continue;

                totalQuantityUSD = totalQuantityUSD.minus(quantityToSell);
                const salePrice = new Decimal(tx.credit).div(quantityToSell);
                const remainingLots = [];

                for (const lot of lotsUSD) {
                    if (quantityToSell.isZero()) {
                        remainingLots.push(lot);
                        continue;
                    }

                    const qtyFromLot = Decimal.min(quantityToSell, lot.quantity);
                    const costInUSD = lot.price.times(qtyFromLot).times(lot.rate);
                    const proceedsInUSD = salePrice.times(qtyFromLot).times(sellRate);
                    realizedPnLInUSD = realizedPnLInUSD.plus(proceedsInUSD.minus(costInUSD));

                    const remaining = lot.quantity.minus(qtyFromLot);
                    if (remaining.gt(0)) {
                        remainingLots.push({ ...lot, quantity: remaining });
                    }
                    quantityToSell = quantityToSell.minus(qtyFromLot);
                }
                lotsUSD.length = 0;
                lotsUSD.push(...remainingLots);
            }
        }

        state.totalInvestedInUSD = totalInvestedInUSD;
        state.realizedPnLInUSD = realizedPnLInUSD;
        state.costBasisInUSD = lotsUSD.reduce((sum, lot) => sum.plus(lot.quantity.times(lot.price).times(lot.rate)), new Decimal(0));


    } else if (itemType === 'Debt') {
        const originationTx = convertedTransactions.find(tx => tx.credit && new Decimal(tx.credit).gt(0));
        const initialBalance = originationTx ? new Decimal(originationTx.credit) : new Decimal(0);

        const totalPaid = convertedTransactions
            .filter(tx => tx.debit && new Decimal(tx.debit).gt(0))
            .reduce((sum, tx) => sum.plus(tx.debit), new Decimal(0));
        
        const finalBalance = initialBalance.minus(totalPaid);
        
        state.costBasis = initialBalance;
        state.currentValue = finalBalance.negated();
        state.realizedPnL = new Decimal(0);
        state.quantity = 1;

        // Calculate USD equivalents
        const originationRate = originationTx ? getRate(originationTx.transaction_date) : new Decimal(1);
        state.costBasisInUSD = initialBalance.times(originationRate);
        
        let finalBalanceInUSD = state.costBasisInUSD;
        convertedTransactions.filter(tx => tx.debit && new Decimal(tx.debit).gt(0)).forEach(tx => {
            const rate = getRate(tx.transaction_date);
            finalBalanceInUSD = finalBalanceInUSD.minus(new Decimal(tx.debit).times(rate));
        });

        state.currentValueInUSD = finalBalanceInUSD.negated();
    }

    return state;
}


module.exports = { 
    calculateInvestmentState,
    calculateDebtState,
    calculateTotalInvested,
    calculatePortfolioItemState,
}; 