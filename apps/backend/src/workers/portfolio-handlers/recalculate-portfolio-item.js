const prisma = require('../../../prisma/prisma.js');
const logger = require('../../utils/logger');
const { calculatePortfolioItemState } = require('../../utils/portfolioItemStateCalculator.js');
const { enqueueEvent } = require('../../queues/eventsQueue');

/**
 * Recalculates a single portfolio item from its constituent transactions.
 * This is a granular and efficient way to update an asset after a transaction is edited.
 *
 * @param {object} job The BullMQ job object.
 * @param {string} job.data.tenantId The ID of the tenant.
 * @param {number} job.data.portfolioItemId The ID of the PortfolioItem to recalculate.
 */
const recalculatePortfolioItem = async (job) => {
    const { portfolioItemId } = job.data;
    logger.info(`--- Recalculating portfolio item: ${portfolioItemId} ---`);

    const portfolioItem = await prisma.portfolioItem.findUnique({
        where: { id: portfolioItemId },
        include: { 
            transactions: { 
                orderBy: { transaction_date: 'asc' },
                include: { category: true } // Eager load category for the calculator
            },
            debtTerms: true, // Eager load debt terms for the calculator
        },
    });

    if (!portfolioItem) {
        logger.warn(`Portfolio item ${portfolioItemId} not found. Skipping recalculation.`);
        return { success: false, message: 'Item not found' };
    }

    if (portfolioItem.transactions.length === 0) {
        logger.info(`Portfolio item ${portfolioItemId} has no transactions. Deleting item.`);
        await prisma.portfolioItem.delete({ where: { id: portfolioItemId }});
        return { success: true, message: 'Item deleted due to no transactions.' };
    }

    // --- Start Change: Only perform full recalculation for Investments ---
    let updateData = {
        updatedAt: new Date(),
    };

    if (portfolioItem.category.type === 'Investments') {
        const newState = await calculatePortfolioItemState(portfolioItem.transactions);
        updateData = { ...updateData, ...newState };
        logger.info(`Recalculated state for Investment item: ${portfolioItemId}.`, { newState });
    } else if (portfolioItem.category.type === 'Debt') {
        // For Debt items, we do not perform a state recalculation here.
        // That is the responsibility of the specialized debt processors (e.g., amortizing-loan-processor)
        // which are triggered by other events. This worker's job is simply to acknowledge the update.
        logger.info(`Skipping state recalculation for Debt item ${portfolioItemId}. Specialized processors are responsible for this asset type.`);
    }
    // --- End Change ---

    // --- Update the portfolio item with the new calculation ---
    await prisma.portfolioItem.update({
        where: { id: portfolioItemId },
        data: updateData,
    });

    logger.info(`--- Finished processing portfolio item recalculation: ${portfolioItemId}. ---`);

    // Emit a completion event to trigger downstream processes like scoped analytics.
    await enqueueEvent('PORTFOLIO_ITEMS_RECALCULATED', {
        tenantId: portfolioItem.tenantId,
        portfolioItemIds: [portfolioItemId],
    });

    return { success: true };
};

module.exports = recalculatePortfolioItem; 