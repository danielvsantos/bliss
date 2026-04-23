const { Decimal } = require('decimal.js');
const logger = require('../../utils/logger');
const { enqueueEvent } = require('../../queues/eventsQueue');
const { getOrCreateCurrencyRate } = require('../../services/currencyService');

const prisma = require('../../../prisma/prisma.js');

/**
 * Cash Holdings Processor v1
 * 
 * Responsibility: Authoritative source of truth for CASH asset PortfolioHolding records.
 * Strategy: Transaction-date-only holdings with year-by-year processing for performance.
 * 
 * Key Features:
 * - Only creates holdings on dates with actual transactions (balance changes)
 * - Processes currencies sequentially, years in batches to avoid memory issues
 * - Supports both full rebuilds and scoped rebuilds from oldest affected transaction
 * - Maintains running balance continuity across year boundaries
 */

/**
 * Main entry point for cash holdings processing
 * @param {string} tenantId - The tenant to process
 * @param {Object} scope - Optional scope for targeted rebuilds
 * @param {string} scope.currency - Process only this currency
 * @param {number} scope.year - Process only this year (all currencies unless currency specified)
 * @param {number} scope.month - Process only this month (requires year)
 */
async function processCashHoldings(tenantId, scope = {}) {
    const startTime = Date.now();
    logger.info(`[CashWorker] Starting cash holdings processing for tenant: ${tenantId}`, { scope });

    try {
        if (!scope.currency && !scope.year && !scope.month) {
            // Full rebuild: Delete all existing cash holdings and rebuild from scratch
            await deleteAllCashHoldings(tenantId);
            logger.info(`[CashWorker] Full rebuild: Deleted all existing cash holdings for tenant ${tenantId}`);
            
            // Process all currencies
            const allCurrencies = await getDistinctCurrencies(tenantId);
            logger.info(`[CashWorker] Processing ${allCurrencies.length} currencies: ${allCurrencies.join(', ')}`);
            
            for (const currency of allCurrencies) {
                await processCurrencyHoldings(tenantId, currency, null);
            }
        } else {
            // Scoped rebuild: Only rebuild specific currency/period
            const targetCurrencies = scope.currency ? [scope.currency] : await getDistinctCurrencies(tenantId);
            logger.info(`[CashWorker] Scoped rebuild for currencies: ${targetCurrencies.join(', ')}`);
            
            for (const currency of targetCurrencies) {
                // Find oldest transaction in the scope
                const scopeFilter = buildDateScopeFilter(scope);
                let oldestInScope = await prisma.transaction.findFirst({
                    where: {
                        tenantId,
                        currency,
                        ...scopeFilter
                    },
                    orderBy: { transaction_date: 'asc' }
                });

                // If no transactions match the scoped date range, check if this currency
                // has any transactions at all. The scope year comes from the earliest
                // affected date (often a different currency), so currencies whose first
                // transaction is after the scope year would be incorrectly skipped.
                if (!oldestInScope && Object.keys(scopeFilter).length > 0) {
                    oldestInScope = await prisma.transaction.findFirst({
                        where: { tenantId, currency },
                        orderBy: { transaction_date: 'asc' }
                    });
                }

                if (!oldestInScope) {
                    logger.info(`[CashWorker] No transactions found for ${currency}. Skipping.`);
                    continue;
                }

                const rebuildStartDate = oldestInScope.transaction_date;
                logger.info(`[CashWorker] Rebuilding ${currency} from ${rebuildStartDate.toISOString().split('T')[0]} to present`);
                
                // Delete all holdings from rebuild start date onwards
                await deleteCashHoldingsFromDate(tenantId, currency, rebuildStartDate);
                
                // Rebuild from start date to present
                await processCurrencyHoldings(tenantId, currency, rebuildStartDate);
            }
        }
        
        const duration = Date.now() - startTime;
        logger.info(`[CashWorker] Completed cash holdings processing for tenant ${tenantId}`, { 
            duration: `${duration}ms`,
            scope 
        });
        
        // Emit completion event to trigger downstream processing
        const isFullRebuild = !scope.currency && !scope.year && !scope.month;
        await enqueueEvent('CASH_HOLDINGS_PROCESSED', {
            tenantId,
            isFullRebuild,
            scope,
            originalScope: scope.originalScope,
            portfolioItemIds: scope.portfolioItemIds,
            // Forward the admin-rebuild marker so the lock release path
            // can trace through to `value-all-assets` completion.
            ...(scope._rebuildMeta ? { _rebuildMeta: scope._rebuildMeta } : {}),
        });
        
        return { success: true, duration };
        
    } catch (error) {
        logger.error(`[CashWorker] Failed to process cash holdings for tenant ${tenantId}`, { 
            error: error.message,
            stack: error.stack,
            scope 
        });
        throw error;
    }
}

/**
 * Process holdings for a single currency with year-by-year batching
 * @param {string} tenantId - The tenant ID
 * @param {string} currency - The currency to process  
 * @param {Date|null} startDate - Start date for processing (null = from beginning)
 */
async function processCurrencyHoldings(tenantId, currency, startDate = null) {
    const cashItem = await getOrCreateCashPortfolioItem(tenantId, currency);
    if (!cashItem) {
        logger.warn(`[CashWorker] No cash portfolio item found or created for ${currency}. Skipping.`);
        return;
    }
    
    // Get starting balance (if rebuilding from middle)
    let runningBalance = startDate ? 
        await getBalanceBeforeDate(tenantId, currency, startDate) : 
        new Decimal(0);
    
    logger.info(`[CashWorker] Starting ${currency} processing with balance: ${runningBalance.toString()}`);
    
    // Process year by year to avoid huge queries
    const startYear = startDate ? startDate.getFullYear() : await getFirstTransactionYear(tenantId, currency);
    const currentYear = new Date().getFullYear();
    
    const allHoldingsToCreate = [];
    
    for (let year = startYear; year <= currentYear; year++) {
        const yearStartDate = new Date(Date.UTC(year, 0, 1));
        const yearEndDate = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
        
        // If we have a specific start date in the first year, use it
        const actualStartDate = (year === startYear && startDate) ? startDate : yearStartDate;
        
        // Batch fetch transactions for this currency + year
        // Only select the fields needed for balance calculation — avoids AES-256-GCM
        // decryption of description/details via the encryption middleware.
        const yearTransactions = await prisma.transaction.findMany({
            where: {
                tenantId,
                currency,
                transaction_date: {
                    gte: actualStartDate,
                    lte: yearEndDate
                }
            },
            select: {
                transaction_date: true,
                credit: true,
                debit: true,
            },
            orderBy: { transaction_date: 'asc' }
        });
        
        if (yearTransactions.length === 0) {
            logger.info(`[CashWorker] No transactions found for ${currency} in ${year}`);
            continue;
        }
        
        // Process this year's transactions
        const yearResult = await processYearTransactions(yearTransactions, runningBalance, cashItem.id);
        allHoldingsToCreate.push(...yearResult.holdings);
        runningBalance = yearResult.finalBalance; // ✅ Carry balance to next year
        
        logger.info(`[CashWorker] Processed ${yearTransactions.length} transactions for ${currency} in ${year}`, {
            tenantId,
            currency,
            year,
            holdingsCreated: yearResult.holdings.length,
            finalBalance: runningBalance.toString()
        });
    }
    
    // Bulk insert all holdings for this currency
    if (allHoldingsToCreate.length > 0) {
        await prisma.portfolioHolding.createMany({
            data: allHoldingsToCreate,
            skipDuplicates: true
        });
        logger.info(`[CashWorker] Bulk inserted ${allHoldingsToCreate.length} holdings for ${currency}`);
    }
    
    // Update portfolio item with final balance
    await updatePortfolioItemBalance(cashItem.id, runningBalance);
    
    logger.info(`[CashWorker] Completed ${currency} processing`, {
        tenantId,
        currency,
        totalHoldings: allHoldingsToCreate.length,
        finalBalance: runningBalance.toString()
    });
}

/**
 * Process transactions for a single year
 * @param {Array} transactions - Transactions for the year
 * @param {Decimal} startingBalance - Balance at start of year
 * @param {number} portfolioItemId - Portfolio item ID
 * @returns {Object} { holdings: Array, finalBalance: Decimal }
 */
async function processYearTransactions(transactions, startingBalance, portfolioItemId) {
    const holdings = [];
    let runningBalance = startingBalance;
    
    // Group transactions by date (transaction-date-only strategy)
    const transactionsByDate = groupTransactionsByDate(transactions);
    
    for (const [dateStr, dayTransactions] of Object.entries(transactionsByDate)) {
        // Calculate net flow for this date
        const dayNetFlow = dayTransactions.reduce((sum, tx) => 
            sum.plus(tx.credit || 0).minus(tx.debit || 0), new Decimal(0)
        );
        
        runningBalance = runningBalance.plus(dayNetFlow);
        
        // Create holding for this transaction date (even if balance becomes 0)
        holdings.push({
            portfolioItemId,
            date: new Date(dateStr),
            quantity: runningBalance,
            totalValue: runningBalance,
            costBasis: new Decimal(0) // Cash has no cost basis
        });
    }
    
    return {
        holdings,
        finalBalance: runningBalance
    };
}

// --- Helper Functions ---

/**
 * Get or create the cash portfolio item for a specific currency.
 * Creates the item on-demand if it doesn't exist, so the cash processor
 * is self-sufficient even when process-portfolio-changes has never run
 * (e.g. pure cash accounts, simple income/expense transactions).
 */
async function getOrCreateCashPortfolioItem(tenantId, currency) {
    const existing = await prisma.portfolioItem.findFirst({
        where: {
            tenantId,
            currency,
            category: { processingHint: 'CASH' }
        }
    });
    if (existing) return existing;

    // Not found — create it on-demand using the tenant's CASH category
    const cashCategory = await prisma.category.findFirst({
        where: { tenantId, processingHint: 'CASH' }
    });
    if (!cashCategory) {
        logger.warn(`[CashWorker] No CASH category found for tenant ${tenantId}. Cannot create portfolio item for ${currency}.`);
        return null;
    }

    const symbol = `Cash ${currency}`;
    logger.info(`[CashWorker] Creating missing cash portfolio item: ${symbol} for tenant ${tenantId}`);
    return await prisma.portfolioItem.upsert({
        where: { tenantId_symbol: { tenantId, symbol } },
        update: {},
        create: {
            tenantId,
            categoryId: cashCategory.id,
            symbol,
            currency,
            source: 'SYSTEM',
        }
    });
}

/**
 * Get balance before a specific date for scoped rebuilds
 */
async function getBalanceBeforeDate(tenantId, currency, date) {
    const lastHolding = await prisma.portfolioHolding.findFirst({
        where: {
            asset: { 
                tenantId, 
                currency,
                category: { processingHint: 'CASH' }
            },
            date: { lt: date }
        },
        orderBy: { date: 'desc' }
    });
    
    return lastHolding ? new Decimal(lastHolding.totalValue) : new Decimal(0);
}

/**
 * Get the year of the first transaction for a currency
 */
async function getFirstTransactionYear(tenantId, currency) {
    const firstTransaction = await prisma.transaction.findFirst({
        where: { tenantId, currency },
        orderBy: { transaction_date: 'asc' }
    });
    
    return firstTransaction ? firstTransaction.transaction_date.getFullYear() : new Date().getFullYear();
}

/**
 * Get all distinct currencies for a tenant
 */
async function getDistinctCurrencies(tenantId) {
    const result = await prisma.transaction.findMany({
        where: { tenantId },
        select: { currency: true },
        distinct: ['currency']
    });
    
    return result.map(r => r.currency);
}

/**
 * Group transactions by date string
 */
function groupTransactionsByDate(transactions) {
    return transactions.reduce((groups, tx) => {
        const dateStr = tx.transaction_date.toISOString().split('T')[0];
        if (!groups[dateStr]) groups[dateStr] = [];
        groups[dateStr].push(tx);
        return groups;
    }, {});
}

/**
 * Build date scope filter for Prisma queries
 */
function buildDateScopeFilter(scope) {
    if (scope.year && scope.month) {
        const start = new Date(Date.UTC(scope.year, scope.month - 1, 1));
        const end = new Date(Date.UTC(scope.year, scope.month, 0, 23, 59, 59, 999));
        return { transaction_date: { gte: start, lte: end } };
    } else if (scope.year) {
        const start = new Date(Date.UTC(scope.year, 0, 1));
        const end = new Date(Date.UTC(scope.year, 11, 31, 23, 59, 59, 999));
        return { transaction_date: { gte: start, lte: end } };
    }
    return {};
}

/**
 * Delete all cash holdings for a tenant
 */
async function deleteAllCashHoldings(tenantId) {
    await prisma.portfolioHolding.deleteMany({
        where: { 
            asset: { 
                tenantId,
                category: { processingHint: 'CASH' }
            }
        }
    });
}

/**
 * Delete cash holdings from a specific date onwards
 */
async function deleteCashHoldingsFromDate(tenantId, currency, fromDate) {
    await prisma.portfolioHolding.deleteMany({
        where: { 
            asset: { 
                tenantId, 
                currency,
                category: { processingHint: 'CASH' }
            },
            date: { gte: fromDate }
        }
    });
}

/**
 * Update portfolio item with final balance and USD conversion
 */
async function updatePortfolioItemBalance(portfolioItemId, balance) {
    // Get the portfolio item to know its currency
    const portfolioItem = await prisma.portfolioItem.findUnique({
        where: { id: portfolioItemId },
        select: { currency: true }
    });
    
    if (!portfolioItem) {
        logger.error(`[CashWorker] Portfolio item ${portfolioItemId} not found for balance update`);
        return;
    }
    
    let balanceInUSD = balance;
    
    // Convert to USD if not already in USD
    if (portfolioItem.currency !== 'USD') {
        try {
            const rateCache = new Map();
            const rate = await getOrCreateCurrencyRate(new Date(), portfolioItem.currency, 'USD', rateCache);
            if (rate) {
                balanceInUSD = balance.times(rate);
            } else {
                logger.warn(`[CashWorker] Could not fetch USD rate for ${portfolioItem.currency}. USD value will be 0.`);
                balanceInUSD = new Decimal(0);
            }
        } catch (error) {
            logger.error(`[CashWorker] Error fetching currency rate for ${portfolioItem.currency}:`, error.message);
            balanceInUSD = new Decimal(0);
        }
    }
    
    await prisma.portfolioItem.update({
        where: { id: portfolioItemId },
        data: {
            quantity: balance,
            currentValue: balance,
            currentValueInUSD: balanceInUSD
        }
    });
}

module.exports = {
    processCashHoldings
};
