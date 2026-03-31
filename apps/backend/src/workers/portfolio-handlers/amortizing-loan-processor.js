const prisma = require('../../../prisma/prisma.js');
const logger = require('../../utils/logger');
const { Decimal } = require('@prisma/client/runtime/library');
const { getRatesForDateRange } = require('../../services/currencyService');

/**
 * Generates historical portfolio holdings for amortizing loan assets.
 *
 * @param {object} job The BullMQ job object.
 * @param {object} job.data Contains tenantId and a list of debt assets.
 */
const processAmortizingLoan = async (job) => {
    const { tenantId, debts } = job.data;
    logger.info(`--- Starting Amortizing Loan Processor for tenant ${tenantId} on ${debts.length} debt item(s) ---`);

    // --- Start Change: Pre-fetch currency rates for all debts in the job ---
    const currencyRateCache = new Map();
    try {
        const currenciesToFetch = new Set(debts.filter(d => d.currency !== 'USD').map(d => d.currency));
        if (currenciesToFetch.size > 0) {
            const debtIds = debts.map(d => d.id);

            // 1. Fetch all relevant DebtTerms in one go.
            const allDebtTerms = await prisma.debtTerms.findMany({
                where: { assetId: { in: debtIds } }
            });

            // 2. Find the earliest transaction date.
            const firstTransaction = await prisma.transaction.findFirst({
                where: { portfolioItemId: { in: debtIds }, tenantId },
                orderBy: { transaction_date: 'asc' },
            });

            // 3. Determine the true earliest date by comparing transaction dates and DebtTerms origination dates.
            let earliestDate = firstTransaction ? new Date(firstTransaction.transaction_date) : new Date();
            for (const terms of allDebtTerms) {
                const termsDate = new Date(terms.originationDate);
                if (termsDate < earliestDate) {
                    earliestDate = termsDate;
                }
            }

            if (earliestDate) {
                const today = new Date();
                for (const currency of currenciesToFetch) {
                    const ratesMap = await getRatesForDateRange(earliestDate, today, currency, 'USD');
                    for (const [dateStr, rate] of ratesMap.entries()) {
                        const cacheKey = `${dateStr}_${currency}_USD`;
                        currencyRateCache.set(cacheKey, rate);
                    }
                    logger.info(`[DebtProc] Pre-fetched ${ratesMap.size} currency rates for ${currency}-USD.`);
                }
            }
        }
    } catch (error) {
        logger.error(`[DebtProc] Failed to pre-fetch currency rates for tenant ${tenantId}.`, { error: error.message });
    }
    // --- End Change ---

    for (const debt of debts) {
        try {
            logger.info(`[DebtProc] Processing loan: ${debt.symbol}`, { tenantId, assetId: debt.id });

            let initialBalance;
            let originationDate;
            let initialBalanceInUSD = new Decimal(0);

            logger.info(`[DebtProc] Attempting to find DebtTerms for assetId: ${debt.id}`, { tenantId });
            const debtTerms = await prisma.debtTerms.findUnique({ where: { assetId: debt.id } });
            
            if (debtTerms) {
                initialBalance = new Decimal(debtTerms.initialBalance);
                originationDate = new Date(debtTerms.originationDate);
            } else {
                logger.warn(`[DebtProc] No DebtTerms found for loan ${debt.symbol}. Falling back to origination transaction.`, { tenantId, assetId: debt.id });
                const originationTx = await prisma.transaction.findFirst({
                    where: {
                        portfolioItemId: debt.id,
                        tenantId: tenantId, // Hardening the query
                        credit: { gt: 0 },
                    },
                    orderBy: { transaction_date: 'asc' }
                });

                if (!originationTx) {
                    logger.error(`[DebtProc] No DebtTerms AND no origination transaction found for ${debt.symbol}. Skipping.`, { tenantId, assetId: debt.id });
                    continue;
                }

                initialBalance = new Decimal(originationTx.credit);
                originationDate = new Date(originationTx.transaction_date);
            }

            // Calculate initial balance in USD
            if (debt.currency !== 'USD') {
                const dateStr = originationDate.toISOString().split('T')[0];
                const cacheKey = `${dateStr}_${debt.currency}_USD`;
                const rate = currencyRateCache.get(cacheKey);
                if (rate) {
                    initialBalanceInUSD = initialBalance.times(rate);
                }
            } else {
                initialBalanceInUSD = initialBalance;
            }

            const principalPayments = await prisma.transaction.findMany({
                where: {
                    portfolioItemId: debt.id,
                    debit: { gt: 0 } // A principal payment is always a debit
                },
                orderBy: { transaction_date: 'asc' }
            });

            const paymentsByDate = principalPayments.reduce((acc, tx) => {
                const dateStr = tx.transaction_date.toISOString().split('T')[0];
                acc[dateStr] = (acc[dateStr] || new Decimal(0)).plus(tx.debit || 0);
                return acc;
            }, {});

            let holdingsToCreate = [];
            let currentBalance = initialBalance;
            let currentBalanceInUSD = initialBalanceInUSD;
            const today = new Date();
            today.setUTCHours(0, 0, 0, 0);

            // Use a while loop with UTC dates to safely iterate across days and avoid DST issues.
            let currentDateIterator = new Date(Date.UTC(originationDate.getUTCFullYear(), originationDate.getUTCMonth(), originationDate.getUTCDate()));

            while (currentDateIterator <= today) {
                const currentDate = new Date(currentDateIterator); // Use a non-mutated copy for processing
                const dateStr = currentDate.toISOString().split('T')[0];

                if (paymentsByDate[dateStr]) {
                    const paymentAmount = paymentsByDate[dateStr];
                    currentBalance = currentBalance.minus(paymentAmount);
                    
                    if (debt.currency !== 'USD') {
                        const cacheKey = `${dateStr}_${debt.currency}_USD`;
                        const rate = currencyRateCache.get(cacheKey);
                        if (rate) {
                            currentBalanceInUSD = currentBalanceInUSD.minus(paymentAmount.times(rate));
                        }
                    } else {
                        currentBalanceInUSD = currentBalanceInUSD.minus(paymentAmount);
                    }
                }
                
                // Ensure balance doesn't go below zero
                currentBalance = Decimal.max(0, currentBalance);
                currentBalanceInUSD = Decimal.max(0, currentBalanceInUSD);

                holdingsToCreate.push({
                    portfolioItemId: debt.id,
                    date: currentDate,
                    quantity: 1,
                    costBasis: initialBalance,
                    totalValue: currentBalance.negated(), // Liabilities are stored as negative values
                    // New USD fields for holdings are not in the schema yet, but preparing for it.
                });

                // Safely advance to the next UTC day
                currentDateIterator.setUTCDate(currentDateIterator.getUTCDate() + 1);
            }

            if (holdingsToCreate.length > 0) {
                await prisma.portfolioHolding.createMany({
                    data: holdingsToCreate,
                    skipDuplicates: true,
                });
                logger.info(`[DebtProc] Created ${holdingsToCreate.length} holding records for loan ${debt.symbol}`, { tenantId, assetId: debt.id });
            }

            // Recalculate the final balance deterministically to avoid race conditions.
            const totalPrincipalPaid = principalPayments.reduce(
                (sum, tx) => sum.plus(tx.debit || 0),
                new Decimal(0)
            );
            const finalBalance = initialBalance.minus(totalPrincipalPaid);
            
            let finalBalanceInUSD = new Decimal(0);
            if(debt.currency === 'USD') {
                finalBalanceInUSD = finalBalance;
            } else {
                 // Recalculate final USD balance for accuracy
                let tempUsdBalance = initialBalanceInUSD;
                for(const tx of principalPayments) {
                    const dateStr = tx.transaction_date.toISOString().split('T')[0];
                    const cacheKey = `${dateStr}_${debt.currency}_USD`;
                    const rate = currencyRateCache.get(cacheKey);
                    if(rate) {
                        tempUsdBalance = tempUsdBalance.minus(new Decimal(tx.debit).times(rate));
                    }
                }
                finalBalanceInUSD = tempUsdBalance;
            }

            // Update the master PortfolioItem with the final state
            await prisma.portfolioItem.update({
                where: { id: debt.id },
                data: {
                    quantity: 1,
                    costBasis: initialBalance,
                    currentValue: finalBalance.negated(),
                    costBasisInUSD: initialBalanceInUSD,
                    currentValueInUSD: finalBalanceInUSD.negated(),
                    realizedPnLInUSD: 0, // Not applicable for simple debt
                    totalInvestedInUSD: 0, // Not applicable for simple debt
                }
            });
            logger.info(`[DebtProc] Updated final state for PortfolioItem ${debt.symbol}`, { tenantId, assetId: debt.id });

        } catch (error) {
            logger.error(`Error processing loan ${debt.id}: ${error.message}`, {
                tenantId,
                assetId: debt.id,
                stack: error.stack,
            });
        }
    }

    logger.info(`--- Finished Amortizing Loan Processor for tenant ${tenantId}. ---`);
    return { success: true };
};

module.exports = processAmortizingLoan; 