import { Decimal } from '@prisma/client/runtime/library';

/**
 * Handles the splitting of a debt repayment transaction into principal and interest.
 * If the transaction is not a splittable debt repayment, it returns null.
 *
 * @param {object} prisma - The Prisma client instance.
 * @param {string} tenantId - The ID of the tenant.
 * @param {string} userId - The ID of the user performing the action.
 * @param {object} transactionData - The original transaction data from the request.
 * @returns {Promise<object[]|null>} A promise that resolves to an array of the split transactions (principal and interest) or null if no split occurred.
 */
export async function handleDebtRepayment(prisma, tenantId, userId, transactionData) {
    const { categoryId, debit, transaction_date } = transactionData;

    // Find the category to ensure it's a Debt type
    const category = await prisma.category.findUnique({ where: { id: transactionData.categoryId } });
    if (!category || category.type !== 'Debt') {
      return null;
    }
  
    // Generate the symbol using the same logic as the backend sync process.
    const portfolioItemSymbol = category.name.replace(/\s/g, '_');

    // Find a portfolio item that matches the generated symbol and has debt terms.
    const portfolioItem = await prisma.portfolioItem.findFirst({
        where: {
            tenantId,
            symbol: portfolioItemSymbol
        },
        include: { debtTerms: true }
    });
  
    // If no item or no debt terms, it's not a splittable loan payment.
    if (!portfolioItem || !portfolioItem.debtTerms) {
      return null;
    }
  
    // --- Start of Interest Calculation Logic ---
    const { interestRate, initialBalance, termInMonths, originationDate } = portfolioItem.debtTerms;
  
    // Dynamically calculate the current balance by summing past principal payments.
    const { _sum } = await prisma.transaction.aggregate({
        where: {
            portfolioItemId: portfolioItem.id,
            categoryId: category.id, // This is crucial to only sum principal payments.
        },
        _sum: { debit: true },
    });

    const pastPrincipalPayments = _sum.debit || new Decimal(0);
    const currentBalance = new Decimal(initialBalance).minus(pastPrincipalPayments);

    const monthlyInterestRate = new Decimal(interestRate).div(100).div(12);
    const calculatedInterest = currentBalance.mul(monthlyInterestRate);
    
    const interestPayment = Decimal.min(new Decimal(debit), calculatedInterest).toDecimalPlaces(2);
    const principalPayment = new Decimal(debit).sub(interestPayment).toDecimalPlaces(2);
    // --- End of Interest Calculation Logic ---

    // Find or create the 'Interest Expense' category with the correct, fixed classification.
    const interestCategoryName = 'Interest Expense';
    let interestCategory = await prisma.category.findFirst({
      where: {
        tenantId,
        name: interestCategoryName,
        group: 'Debt Expenses',
        type: 'Essentials',
      },
    });

    if (!interestCategory) {
      interestCategory = await prisma.category.create({
        data: {
          tenantId,
          name: interestCategoryName,
          group: 'Debt Expenses',
          type: 'Essentials',
        },
      });
    }
  
    const transactionsToCreate = [];

    // Create the principal portion of the transaction
    if (principalPayment.gt(0)) {
        transactionsToCreate.push({
            ...transactionData,
            debit: principalPayment,
            tenantId,
            userId,
        });
    }

    // Create the interest portion of the transaction
    if (interestPayment.gt(0)) {
        transactionsToCreate.push({
            ...transactionData,
            debit: interestPayment,
            categoryId: interestCategory.id,
            tenantId,
            userId,
        });
    }

    if (transactionsToCreate.length === 0) {
        return null; // Nothing to create, though this is unlikely if debit > 0
    }
  
    // This function now returns the data for the transactions, to be created by the caller.
    return transactionsToCreate;
} 