const prisma = require('../../../prisma/prisma.js');
const logger = require('../../utils/logger');
const { Decimal } = require('@prisma/client/runtime/library');
const { getRatesForDateRange } = require('../../services/currencyService');

/**
 * Generates historical portfolio holdings for simple liability assets (e.g., personal loans).
 *
 * @param {object} job The BullMQ job object.
 * @param {object} job.data Contains tenantId and a list of debt assets.
 */
const processSimpleLiability = async (job) => {
    const { tenantId, debts } = job.data;
    logger.info(`--- Starting Simple Liability Processor for tenant ${tenantId} on ${debts.length} debt item(s) ---`);

    // --- Pre-fetch all necessary currency rates ---
    const currencyRateCache = new Map();
    try {
        const currenciesToFetch = new Set(debts.filter(d => d.currency !== 'USD').map(d => d.currency));
        if (currenciesToFetch.size > 0) {
            const firstTransaction = await prisma.transaction.findFirst({
                where: { portfolioItemId: { in: debts.map(d => d.id) }, tenantId },
                orderBy: { transaction_date: 'asc' },
            });

            if (firstTransaction) {
                const earliestDate = new Date(firstTransaction.transaction_date);
                const today = new Date();
                for (const currency of currenciesToFetch) {
                    const ratesMap = await getRatesForDateRange(earliestDate, today, currency, 'USD');
                    for (const [dateStr, rate] of ratesMap.entries()) {
                        const cacheKey = `${dateStr}_${currency}_USD`;
                        currencyRateCache.set(cacheKey, rate);
                    }
                    logger.info(`[SimpleDebt] Pre-fetched ${ratesMap.size} currency rates for ${currency}-USD.`);
                }
            }
        }
    } catch (error) {
        logger.error(`[SimpleDebt] Failed to pre-fetch currency rates for tenant ${tenantId}.`, { error: error.message });
    }

    for (const debt of debts) {
        // BullMQ lock heartbeat — self rate-limiting, safe to call
        // unconditionally. See `utils/jobHeartbeat.js`.
        await job.heartbeat?.();
        try {
            logger.info(`[SimpleDebt] Processing loan: ${debt.symbol}`, { tenantId, assetId: debt.id });

            const allTransactions = await prisma.transaction.findMany({
                where: { portfolioItemId: debt.id },
                orderBy: { transaction_date: 'asc' }
            });

            const originationTx = allTransactions.find(tx => tx.credit && tx.credit.gt(0));
            if (!originationTx) {
                logger.warn(`[SimpleDebt] No origination (credit) transaction found for ${debt.symbol}. Skipping.`, { tenantId, assetId: debt.id });
                continue;
            }

            const initialBalance = new Decimal(originationTx.credit);
            const originationDate = new Date(originationTx.transaction_date);
            
            let initialBalanceInUSD = new Decimal(0);
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

            const paymentsByDate = allTransactions
                .filter(tx => tx.debit && tx.debit.gt(0))
                .reduce((acc, tx) => {
                    const dateStr = tx.transaction_date.toISOString().split('T')[0];
                    acc[dateStr] = (acc[dateStr] || new Decimal(0)).plus(tx.debit);
                    return acc;
                }, {});

            let holdingsToCreate = [];
            let currentBalance = initialBalance;
            let currentBalanceInUSD = initialBalanceInUSD;
            const today = new Date();
            today.setUTCHours(0, 0, 0, 0);

            for (let day = new Date(originationDate); day <= today; day.setDate(day.getDate() + 1)) {
                const currentDate = new Date(day);
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
                
                currentBalance = Decimal.max(0, currentBalance);
                currentBalanceInUSD = Decimal.max(0, currentBalanceInUSD);

                holdingsToCreate.push({
                    portfolioItemId: debt.id,
                    date: currentDate,
                    quantity: 1,
                    costBasis: initialBalance,
                    totalValue: currentBalance.negated(),
                });
            }

            if (holdingsToCreate.length > 0) {
                await prisma.portfolioHolding.createMany({
                    data: holdingsToCreate,
                    skipDuplicates: true,
                });
                logger.info(`[SimpleDebt] Created ${holdingsToCreate.length} holding records for loan ${debt.symbol}`, { tenantId, assetId: debt.id });
            }

            const finalBalance = currentBalance;
            const finalBalanceInUSD = currentBalanceInUSD;

            await prisma.portfolioItem.update({
                where: { id: debt.id },
                data: {
                    quantity: 1,
                    costBasis: initialBalance,
                    currentValue: finalBalance.negated(),
                    costBasisInUSD: initialBalanceInUSD,
                    currentValueInUSD: finalBalanceInUSD.negated(),
                }
            });
            logger.info(`[SimpleDebt] Updated final state for PortfolioItem ${debt.symbol}`, { tenantId, assetId: debt.id });

        } catch (error) {
            logger.error(`[SimpleDebt] Error processing loan ${debt.id}: ${error.message}`, {
                tenantId,
                assetId: debt.id,
                stack: error.stack,
            });
        }
    }

    logger.info(`--- Finished Simple Liability Processor for tenant ${tenantId}. ---`);
    return { success: true };
};

module.exports = processSimpleLiability; 