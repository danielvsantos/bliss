const logger = require('../../utils/logger');
const { decrypt } = require('../../utils/encryption');

/**
 * Generates a consistent, unique key for an asset based on a transaction and a defined strategy.
 * @param {object} transaction The transaction object, with its category included.
 * @param {function} decryptFn The decryption function.
 * @returns {string|null} The generated asset key, or null if the strategy is to ignore.
 */
const generateAssetKey = (transaction, decryptFn) => {
    if (!transaction || !transaction.category) {
        return null;
    }

    const { category, description } = transaction;
    const { portfolioItemKeyStrategy, name: categoryName } = category;

    switch (portfolioItemKeyStrategy) {
        case 'TICKER':
            // Validate ticker is a meaningful symbol — reject pure numeric placeholders like "0"
            if (transaction.ticker && /[a-zA-Z]/.test(transaction.ticker)) {
                return transaction.ticker;
            }
            // Fallback for manually-tracked funds without a ticker:
            // group by category + description so each distinct fund gets its own PortfolioItem
            if (category.type === 'Investments' && description) {
                const decryptedDescription = decryptFn(description);
                logger.info(`[AssetAggregator] TICKER fallback for "${categoryName}" — using description key: ${decryptedDescription}`);
                return `${categoryName}:${decryptedDescription}`;
            }
            return null;
        
        case 'CATEGORY_NAME':
            return categoryName;

        case 'CATEGORY_NAME_PLUS_DESCRIPTION': {
            if (!description) return null;
            const decryptedDescription = decryptFn(description);
            return `${categoryName}:${decryptedDescription}`;
        }

        case 'IGNORE':
        default:
            return null;
    }
};

module.exports = {
    generateAssetKey,
}; 