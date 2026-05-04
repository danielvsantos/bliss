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
 * Main entry point for cash holdings processing.
 *
 * Cash portfolio items are now per (currency, accountId): each brokerage account
 * has its own cash balance tracked independently.
 *
 * @param {string} tenantId - The tenant to process
 * @param {Object} scope - Optional scope for targeted rebuilds
 * @param {string} scope.currency - Process only this currency
 * @param {number} scope.accountId - Process only this account
 * @param {number} scope.year - Process only this year
 * @param {number} scope.month - Process only this month (requires year)
 */
async function processCashHoldings(tenantId, scope = {}) {
    const startTime = Date.now();
    logger.info(`[CashWorker] Starting cash holdings processing for tenant: ${tenantId}`, { scope });

    try {
        if (!scope.currency && !scope.accountId && !scope.year && !scope.month) {
            // Full rebuild: Delete all existing cash holdings and rebuild from scratch
            await deleteAllCashHoldings(tenantId);
            logger.info(`[CashWorker] Full rebuild: Deleted all existing cash holdings for tenant ${tenantId}`);

            // Process all (currency, accountId) pairs — each account has its own cash balance.
            const allPairs = await getDistinctCurrencyAccountPairs(tenantId);
            logger.info(`[CashWorker] Processing ${allPairs.length} (currency, account) pairs.`);

            for (const { currency, accountId } of allPairs) {
                await processCurrencyAccountHoldings(tenantId, currency, accountId, null);
            }
        } else {
            // Scoped rebuild: Only rebuild specific currency/account/period.
            const targetPairs = (scope.currency || scope.accountId)
                ? await getDistinctCurrencyAccountPairs(tenantId, scope.currency, scope.accountId)
                : await getDistinctCurrencyAccountPairs(tenantId);
            logger.info(`[CashWorker] Scoped rebuild for ${targetPairs.length} (currency, account) pairs.`);

            for (const { currency, accountId } of targetPairs) {
                // Find oldest transaction in the scope
                const scopeFilter = buildDateScopeFilter(scope);
                let oldestInScope = await prisma.transaction.findFirst({
                    where: {
                        tenantId,
                        currency,
                        accountId,
                        ...scopeFilter
                    },
                    orderBy: { transaction_date: 'asc' }
                });

                // If no transactions match the scoped date range, fall back to
                // the earliest transaction for this (currency, account) pair so
                // currencies whose first transaction is after the scope year are
                // not incorrectly skipped.
                if (!oldestInScope && Object.keys(scopeFilter).length > 0) {
                    oldestInScope = await prisma.transaction.findFirst({
                        where: { tenantId, currency, accountId },
                        orderBy: { transaction_date: 'asc' }
                    });
                }

                if (!oldestInScope) {
                    logger.info(`[CashWorker] No transactions found for ${currency} / account ${accountId}. Skipping.`);
                    continue;
                }

                const rebuildStartDate = oldestInScope.transaction_date;
                logger.info(`[CashWorker] Rebuilding ${currency} / account ${accountId} from ${rebuildStartDate.toISOString().split('T')[0]} to present`);

                // Delete all holdings from rebuild start date onwards for this (currency, account) pair.
                await deleteCashHoldingsFromDate(tenantId, currency, accountId, rebuildStartDate);

                // Rebuild from start date to present.
                await processCurrencyAccountHoldings(tenantId, currency, accountId, rebuildStartDate);
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
 * Process holdings for a single (currency, accountId) pair with year-by-year batching.
 * @param {string} tenantId - The tenant ID
 * @param {string} currency - The currency to process
 * @param {number} accountId - The account ID
 * @param {Date|null} startDate - Start date for processing (null = from beginning)
 */
async function processCurrencyAccountHoldings(tenantId, currency, accountId, startDate = null) {
    const cashItem = await getOrCreateCashPortfolioItem(tenantId, currency, accountId);
    if (!cashItem) {
        logger.warn(`[CashWorker] No cash portfolio item found or created for ${currency} / account ${accountId}. Skipping.`);
        return;
    }

    // Get starting balance (if rebuilding from middle)
    let runningBalance = startDate
        ? await getBalanceBeforeDate(tenantId, currency, accountId, startDate)
        : new Decimal(0);

    logger.info(`[CashWorker] Starting ${currency} / account ${accountId} processing with balance: ${runningBalance.toString()}`);

    // Process year by year to avoid huge queries
    const startYear = startDate ? startDate.getFullYear() : await getFirstTransactionYear(tenantId, currency, accountId);
    const currentYear = new Date().getFullYear();

    const allHoldingsToCreate = [];

    for (let year = startYear; year <= currentYear; year++) {
        const yearStartDate = new Date(Date.UTC(year, 0, 1));
        const yearEndDate = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));

        // If we have a specific start date in the first year, use it
        const actualStartDate = (year === startYear && startDate) ? startDate : yearStartDate;

        // Batch fetch transactions for this (currency, accountId, year).
        // Only select the fields needed for balance calculation — avoids AES-256-GCM
        // decryption of description/details via the encryption middleware.
        const yearTransactions = await prisma.transaction.findMany({
            where: {
                tenantId,
                currency,
                accountId,
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
            logger.info(`[CashWorker] No transactions found for ${currency} / account ${accountId} in ${year}`);
            continue;
        }

        // Process this year's transactions
        const yearResult = await processYearTransactions(yearTransactions, runningBalance, cashItem.id);
        allHoldingsToCreate.push(...yearResult.holdings);
        runningBalance = yearResult.finalBalance; // Carry balance to next year

        logger.info(`[CashWorker] Processed ${yearTransactions.length} transactions for ${currency} / account ${accountId} in ${year}`, {
            tenantId,
            currency,
            accountId,
            year,
            holdingsCreated: yearResult.holdings.length,
            finalBalance: runningBalance.toString()
        });
    }

    // Bulk insert all holdings for this (currency, account)
    if (allHoldingsToCreate.length > 0) {
        await prisma.portfolioHolding.createMany({
            data: allHoldingsToCreate,
            skipDuplicates: true
        });
        logger.info(`[CashWorker] Bulk inserted ${allHoldingsToCreate.length} holdings for ${currency} / account ${accountId}`);
    }

    // Update portfolio item with final balance
    await updatePortfolioItemBalance(cashItem.id, runningBalance);

    logger.info(`[CashWorker] Completed ${currency} / account ${accountId} processing`, {
        tenantId,
        currency,
        accountId,
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
 * Get or create the cash portfolio item for a specific (currency, accountId) pair.
 * Creates the item on-demand if it doesn't exist, so the cash processor
 * is self-sufficient even when process-portfolio-changes has never run
 * (e.g. pure cash accounts, simple income/expense transactions).
 */
async function getOrCreateCashPortfolioItem(tenantId, currency, accountId) {
    const existing = await prisma.portfolioItem.findFirst({
        where: {
            tenantId,
            currency,
            accountId,
            category: { processingHint: 'CASH' }
        }
    });
    if (existing) return existing;

    // Not found — create it on-demand using the tenant's CASH category
    const cashCategory = await prisma.category.findFirst({
        where: { tenantId, processingHint: 'CASH' }
    });
    if (!cashCategory) {
        logger.warn(`[CashWorker] No CASH category found for tenant ${tenantId}. Cannot create portfolio item for ${currency} / account ${accountId}.`);
        return null;
    }

    const symbol = `Cash ${currency}`;
    logger.info(`[CashWorker] Creating missing cash portfolio item: ${symbol} / account ${accountId} for tenant ${tenantId}`);
    return await prisma.portfolioItem.upsert({
        where: { tenantId_symbol_accountId: { tenantId, symbol, accountId } },
        update: {},
        create: {
            tenantId,
            categoryId: cashCategory.id,
            accountId,
            symbol,
            currency,
            source: 'SYSTEM',
        }
    });
}

/**
 * Get balance before a specific date for scoped rebuilds (per currency + account).
 */
async function getBalanceBeforeDate(tenantId, currency, accountId, date) {
    const lastHolding = await prisma.portfolioHolding.findFirst({
        where: {
            asset: {
                tenantId,
                currency,
                accountId,
                category: { processingHint: 'CASH' }
            },
            date: { lt: date }
        },
        orderBy: { date: 'desc' }
    });

    return lastHolding ? new Decimal(lastHolding.totalValue) : new Decimal(0);
}

/**
 * Get the year of the first transaction for a (currency, accountId) pair.
 */
async function getFirstTransactionYear(tenantId, currency, accountId) {
    const firstTransaction = await prisma.transaction.findFirst({
        where: { tenantId, currency, accountId },
        orderBy: { transaction_date: 'asc' }
    });

    return firstTransaction ? firstTransaction.transaction_date.getFullYear() : new Date().getFullYear();
}

/**
 * Get all distinct (currency, accountId) pairs for a tenant.
 * Optionally filter by currency and/or accountId for scoped rebuilds.
 */
async function getDistinctCurrencyAccountPairs(tenantId, currency = null, accountId = null) {
    const result = await prisma.transaction.findMany({
        where: {
            tenantId,
            ...(currency && { currency }),
            ...(accountId && { accountId }),
        },
        select: { currency: true, accountId: true },
        distinct: ['currency', 'accountId'],
    });

    return result.map(r => ({ currency: r.currency, accountId: r.accountId }));
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
 * Delete cash holdings from a specific date onwards for a (currency, accountId) pair.
 */
async function deleteCashHoldingsFromDate(tenantId, currency, accountId, fromDate) {
    await prisma.portfolioHolding.deleteMany({
        where: {
            asset: {
                tenantId,
                currency,
                accountId,
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
