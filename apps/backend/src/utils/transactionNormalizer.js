const { Decimal } = require('@prisma/client/runtime/library');

/**
 * Determines if a transaction should be considered a "buy" action for an investment.
 * This is centralized to ensure consistent logic across all calculators.
 * @param {object} transaction The transaction object.
 * @returns {boolean} True if the transaction is a "buy" action.
 */
const isBuyTransaction = (transaction) => {
  // The primary rule: a debit to a cash account for an investment is a "buy".
  return transaction.debit && new Decimal(transaction.debit).isPositive();
};

/**
 * Determines if a transaction should be considered a "sell" action for an investment.
 * This is centralized to ensure consistent logic across all calculators.
 * @param {object} transaction The transaction object.
 * @returns {boolean} True if the transaction is a "sell" action.
 */
const isSellTransaction = (transaction) => {
  // The primary rule: a credit to a cash account for an investment is a "sell".
  return transaction.credit && new Decimal(transaction.credit).isPositive();
};

/**
 * Normalizes a transaction object in-memory to handle specific business rules,
 * such as missing quantities for certain investment types.
 * This function does NOT modify the original object but returns a new, normalized one if changes are needed.
 * @param {object} transaction The original transaction object.
 * @returns {object} The normalized transaction object.
 */
const normalizeTransaction = (transaction) => {
  const isBuy = isBuyTransaction(transaction);
  const isSell = isSellTransaction(transaction);
  const quantity = new Decimal(transaction.assetQuantity || 0);

  if ((isBuy || isSell) && quantity.isZero()) {
    const price = new Decimal(transaction.assetPrice || 0);

    if (price.isPositive() && !price.isZero()) {
      // Price IS known — calculate the real quantity from amount ÷ price.
      // This aligns with what the transaction form and smart import enrichment form do.
      // Example: buy $1,000 of AAPL @ $200 → qty = 5 (not 1).
      const amt = new Decimal(transaction.debit || transaction.credit || 0).abs();
      return { ...transaction, assetQuantity: amt.div(price) };
      // Note: no _isSellAll when price is available; the calculated qty IS the sell size.
    }

    // Price NOT known — fall back to the unit-proxy model:
    // • Buys: qty = 1 (treat each contribution as one unit; self-consistent for fund-style assets)
    // • Sells: qty = 1 + _isSellAll flag (liquidate the entire accumulated position)
    // This preserves correct behaviour for recurring fund purchases with no per-unit price.
    // Example: 12 monthly fund contributions each get qty=1, then a full redemption wipes them all.
    if (isBuy) {
      return { ...transaction, assetQuantity: new Decimal(1) };
    }
    if (isSell) {
      return {
        ...transaction,
        assetQuantity: new Decimal(1), // Positive quantity (system convention)
        _isSellAll: true, // Flag indicates special "sell all" behavior
      };
    }
  }

  // If no special rules apply, return the original transaction.
  return transaction;
};

module.exports = {
  isBuyTransaction,
  isSellTransaction,
  normalizeTransaction,
};
