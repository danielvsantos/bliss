import prisma from '../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../utils/cors.js';
import { rateLimiters } from '../../utils/rateLimit.js';
import { produceEvent } from '../../utils/produceEvent.js';
import { withAuth } from '../../utils/withAuth.js';

// Function to transform tenant data - MOVED TO TOP LEVEL FOR REUSE
const transformTenantData = (tenant) => {
  if (!tenant) return null;
  // Create a new object excluding tenantBanks before spreading
  const { tenantBanks, transactionYearsRaw, ...rest } = tenant;
  return {
    ...rest, // Spread the tenant object without tenantBanks
    countries: tenant.countries?.map(tc => ({ ...tc.country, isDefault: tc.isDefault })) || [],
    currencies: tenant.currencies?.map(tc => ({ ...tc.currency, isDefault: tc.isDefault })) || [],
    // Map over the original tenantBanks (before exclusion) to extract bank details
    banks: tenant.tenantBanks?.map(tb => tb.bank) || [],
    transactionYears: tenant.transactionYearsRaw?.map(item => item.year) || [],
    plaidLinkedBankIds: tenant.plaidItems?.map(p => p.bankId).filter(Boolean) || [],
  };
};

export default withAuth(async function handler(req, res) {

  // Apply rate limiting
  await new Promise((resolve, reject) => {
    rateLimiters.tenants(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });


  // Handle CORS
  if (cors(req, res)) return;


  try {
    const user = req.user;

    switch (req.method) {
      case 'GET':
        await handleGet(req, res, user);
        break;
      case 'PUT':
        await handlePut(req, res, user);
        break;
      case 'DELETE':
        await handleDelete(req, res, user);
        break;
      default:
        res.setHeader('Allow', ['GET', 'PUT', 'DELETE']);
        res.status(StatusCodes.METHOD_NOT_ALLOWED).json({
          error: 'Method not allowed',
          details: 'New tenants can only be created through the signup process'
        });
        return;
    }
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});

async function handleGet(req, res, user) {
  const { id } = req.query;

  // Common include object
  const includeRelations = {
    countries: { include: { country: true } },
    currencies: { include: { currency: true } },
    tenantBanks: { include: { bank: true } }, // Include TenantBanks and nested Banks
    plaidItems: { select: { bankId: true } } // Include Plaid Items to identify linked banks
  };

  if (id) {
    // Check access using tenantId
    if (user.tenantId !== id) {
      res.status(StatusCodes.FORBIDDEN).json({ error: 'Access denied to this tenant' });
      return;
    }

    // --- Start Change: Fetch transaction years ---
    const transactionYearsRaw = await prisma.$queryRaw`
      SELECT DISTINCT EXTRACT(YEAR FROM "transaction_date")::integer AS year 
      FROM "Transaction" 
      WHERE "tenantId" = ${id} 
      ORDER BY year DESC
    `;
    // --- End Change ---

    // Fetch specific tenant by ID with all relations
    let tenant = await prisma.tenant.findUnique({
      where: { id },
      include: includeRelations
    });

    if (!tenant) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Tenant not found' });
      return;
    }

    // --- Start Change: Attach years to tenant object ---
    tenant.transactionYearsRaw = transactionYearsRaw;
    // --- End Change ---

    res.status(StatusCodes.OK).json(transformTenantData(tenant));
    return;
  }

  // --- Start Change: Handle list of tenants (although it only returns one) ---
  const tenants = await prisma.tenant.findMany({
    where: {
      id: user.tenantId // Only return the tenant the user belongs to
    },
    include: includeRelations
  });

  if (tenants.length > 0) {
    const transactionYearsRaw = await prisma.$queryRaw`
      SELECT DISTINCT EXTRACT(YEAR FROM "transaction_date")::integer AS year 
      FROM "Transaction" 
      WHERE "tenantId" = ${user.tenantId} 
      ORDER BY year DESC
    `;
    tenants[0].transactionYearsRaw = transactionYearsRaw;
  }
  // --- End Change ---

  // Transform each tenant in the list
  const transformedTenants = tenants.map(transformTenantData);

  res.status(StatusCodes.OK).json(transformedTenants);
}

async function handlePut(req, res, user) {
  try {
    const { id } = req.query;
    const { name, plan, countries = [], currencies = [], bankIds = [], portfolioCurrency } = req.body;

    // Simpler tenant access check using the user's tenantId
    if (user.tenantId !== id) {
      res.status(StatusCodes.FORBIDDEN).json({ error: 'Access denied to this tenant' });
      return;
    }

    // --- Start Change: Fetch original currencies + portfolioCurrency before update ---
    const originalTenantState = await prisma.tenant.findUnique({
      where: { id },
      include: { currencies: true }
    });
    const originalCurrencies = originalTenantState?.currencies.map(c => c.currencyId).sort() || [];
    const originalPortfolioCurrency = originalTenantState?.portfolioCurrency || 'USD';
    // --- End Change ---

    // Check if tenant exists
    const tenant = await prisma.tenant.findUnique({
      where: { id }
    });

    if (!tenant) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Tenant not found' });
      return;
    }

    // Validate countries, currencies, AND banks
    const validationPromises = [];
    let uniqueCountries = [];
    let uniqueCurrencies = [];
    let uniqueBankIds = [];

    if (countries.length > 0) {
      uniqueCountries = [...new Set(countries.map(c => c.toUpperCase()))];
      validationPromises.push(prisma.country.findMany({ where: { id: { in: uniqueCountries } } }));
    } else {
      validationPromises.push(Promise.resolve([])); // Placeholder
    }

    if (currencies.length > 0) {
      uniqueCurrencies = [...new Set(currencies.map(c => c.toUpperCase()))];
      validationPromises.push(prisma.currency.findMany({ where: { id: { in: uniqueCurrencies } } }));
    } else {
      validationPromises.push(Promise.resolve([])); // Placeholder
    }

    // Validate Bank IDs
    if (bankIds.length > 0) {
      uniqueBankIds = [...new Set(bankIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id)))];
      if (uniqueBankIds.length !== bankIds.length) {
        res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid bankId format. Must be integers.' });
        return;
      }
      validationPromises.push(prisma.bank.findMany({ where: { id: { in: uniqueBankIds } } }));
    } else {
      validationPromises.push(Promise.resolve([])); // Placeholder
    }

    const [validCountries, validCurrencies, validBanks] = await Promise.all(validationPromises);

    // Check for invalid codes/ids
    const invalidCountries = countries.length > 0 ? uniqueCountries.filter(code => !validCountries.find(c => c.id === code)) : [];
    const invalidCurrencies = currencies.length > 0 ? uniqueCurrencies.filter(code => !validCurrencies.find(c => c.id === code)) : [];
    const invalidBankIds = bankIds.length > 0 ? uniqueBankIds.filter(id => !validBanks.find(b => b.id === id)) : [];

    const errors = {};
    if (invalidCountries.length > 0) errors.invalidCountries = invalidCountries;
    if (invalidCurrencies.length > 0) errors.invalidCurrencies = invalidCurrencies;
    if (invalidBankIds.length > 0) errors.invalidBankIds = invalidBankIds;

    if (Object.keys(errors).length > 0) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Invalid country, currency, or bank IDs',
        details: errors
      });
      return;
    }
    // --- End Validation ---

    // --- Portfolio Currency auto-detection logic ---
    // Determines the portfolioCurrency to set based on the new currency list.
    // Priority: USD > EUR > GBP > first currency in list
    const PORTFOLIO_CURRENCY_PRIORITY = ['USD', 'EUR', 'GBP'];
    let portfolioCurrencyToSet = undefined; // undefined = no change

    if (req.body.hasOwnProperty('portfolioCurrency') && portfolioCurrency) {
      // Explicit portfolioCurrency provided — validate against new or existing currency list
      const currencyList = currencies.length > 0 ? uniqueCurrencies : originalCurrencies;
      if (currencyList.includes(portfolioCurrency.toUpperCase())) {
        portfolioCurrencyToSet = portfolioCurrency.toUpperCase();
      }
      // If invalid, silently ignore (don't fail the whole update)
    } else if (req.body.hasOwnProperty('currencies') && currencies.length > 0) {
      // Currencies being updated — auto-detect if current portfolioCurrency is no longer valid
      if (!uniqueCurrencies.includes(originalPortfolioCurrency)) {
        portfolioCurrencyToSet =
          PORTFOLIO_CURRENCY_PRIORITY.find(c => uniqueCurrencies.includes(c)) || uniqueCurrencies[0];
      }
    }

    // Update tenant and relationships in a transaction
    const updatedTenant = await prisma.$transaction(async (prisma) => {
      // Update basic tenant info — only include fields that were explicitly provided
      const tenant = await prisma.tenant.update({
        where: { id },
        data: {
          ...(req.body.hasOwnProperty('name') && { name }),
          ...(req.body.hasOwnProperty('plan') && { plan }),
          ...(portfolioCurrencyToSet && { portfolioCurrency: portfolioCurrencyToSet }),
        }
      });

      // Update countries (if provided)
      if (countries.length > 0) {
        await prisma.tenantCountry.deleteMany({ where: { tenantId: id } });
        await prisma.tenantCountry.createMany({
          data: uniqueCountries.map((countryId, index) => ({
            tenantId: id, countryId, isDefault: index === 0
          }))
        });
      }

      // Update currencies (if provided)
      if (currencies.length > 0) {
        await prisma.tenantCurrency.deleteMany({ where: { tenantId: id } });
        await prisma.tenantCurrency.createMany({
          data: uniqueCurrencies.map((currencyId, index) => ({
            tenantId: id, currencyId, isDefault: index === 0
          }))
        });
      }

      // Update banks ONLY if bankIds is explicitly provided in the request body
      if (req.body.hasOwnProperty('bankIds')) {
        if (bankIds.length > 0) {
          await prisma.tenantBank.deleteMany({ where: { tenantId: id } });
          await prisma.tenantBank.createMany({
            data: uniqueBankIds.map((bankId) => ({
              tenantId: id, bankId
            }))
          });
        } else {
          // If an empty bankIds array is explicitly provided, clear existing associations
          await prisma.tenantBank.deleteMany({ where: { tenantId: id } });
        }
      }
      // If bankIds is not in the request body, do nothing to existing associations

      // Fetch updated tenant with all relationships
      return prisma.tenant.findUnique({
        where: { id },
        include: {
          users: true,
          countries: { include: { country: true } },
          currencies: { include: { currency: true } },
          tenantBanks: { include: { bank: true } } // Include tenantBanks relation
        }
      });
    });

    // --- Start Change: Compare and dispatch event after update ---
    // Only fire if currencies were explicitly provided in this request (avoids false-positive
    // when the caller only updated countries or name without touching currencies)
    if (req.body.hasOwnProperty('currencies') && currencies.length > 0) {
      const newCurrencies = [...new Set(currencies.map(c => c.toUpperCase()))].sort();
      if (JSON.stringify(originalCurrencies) !== JSON.stringify(newCurrencies)) {
        await produceEvent({
          type: 'TENANT_CURRENCY_SETTINGS_UPDATED',
          tenantId: id,
        });
      }
    }
    // --- End Change ---

    res.status(StatusCodes.OK).json(transformTenantData(updatedTenant));
    return;
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to update tenant',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
}

async function handleDelete(req, res, user) {
  try {
    const { id } = req.query;

    // Authorization: Ensure user is deleting their own tenant
    if (user.tenantId !== id) {
      res.status(StatusCodes.FORBIDDEN).json({ error: 'Access denied' });
      return;
    }

    // Check if the tenant exists
    const tenant = await prisma.tenant.findUnique({
      where: { id },
    });

    if (!tenant) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Tenant not found' });
      return;
    }

    // Perform the deletion in a transaction
    try {
      await prisma.$transaction(async (prisma) => {
        // Step 1: Get IDs of related items for cascading deletes
        const accounts = await prisma.account.findMany({
          where: { tenantId: id },
          select: { id: true },
        });
        const accountIds = accounts.map(a => a.id);

        const portfolioItems = await prisma.portfolioItem.findMany({
          where: { tenantId: id },
          select: { id: true }
        });
        const portfolioItemIds = portfolioItems.map(p => p.id);

        // Step 2: Delete join tables and records with foreign keys to PortfolioItem
        if (accountIds.length > 0) {
          await prisma.accountOwner.deleteMany({ where: { accountId: { in: accountIds } } });
        }
        if (portfolioItemIds.length > 0) {
          await prisma.debtTerms.deleteMany({ where: { assetId: { in: portfolioItemIds } } });
          await prisma.portfolioHolding.deleteMany({ where: { portfolioItemId: { in: portfolioItemIds } } });
          await prisma.portfolioValueHistory.deleteMany({ where: { assetId: { in: portfolioItemIds } } });
          // ManualAssetValue is deleted via cascade when PortfolioItem is deleted
        }

        // Step 2b: Delete AI/Import models before their FK parents
        await prisma.transactionEmbedding.deleteMany({ where: { tenantId: id } });
        // StagedImportRow cascades from StagedImport via onDelete: Cascade
        await prisma.stagedImport.deleteMany({ where: { tenantId: id } });
        await prisma.importAdapter.deleteMany({ where: { tenantId: id } });

        // Step 3: Delete core tenant-scoped records in an order that respects foreign keys
        // TransactionTags must be deleted BEFORE Transactions (FK: transactionId)
        const tags = await prisma.tag.findMany({ where: { tenantId: id }, select: { id: true } });
        const tagIds = tags.map(t => t.id);
        if (tagIds.length > 0) {
          await prisma.transactionTag.deleteMany({ where: { tagId: { in: tagIds } } });
        }

        // Now safe to delete transactions and tags
        await prisma.transaction.deleteMany({ where: { tenantId: id } });
        await prisma.tag.deleteMany({ where: { tenantId: id } });

        // PortfolioItems must be deleted before Categories
        await prisma.portfolioItem.deleteMany({ where: { tenantId: id } });

        // Now it's safe to delete Accounts and Categories
        await prisma.account.deleteMany({ where: { tenantId: id } });
        await prisma.category.deleteMany({ where: { tenantId: id } });

        // Step 4: Delete other tenant-scoped data
        await prisma.analyticsCacheMonthly.deleteMany({ where: { tenantId: id } });
        await prisma.analyticsCacheDaily.deleteMany({ where: { tenantId: id } });
        await prisma.cashFlowCacheDaily.deleteMany({ where: { tenantId: id } });
        await prisma.insight.deleteMany({ where: { tenantId: id } });
        await prisma.auditLog.deleteMany({ where: { tenantId: id } });

        // Step 5: Delete direct tenant relations
        await prisma.tenantCountry.deleteMany({ where: { tenantId: id } });
        await prisma.tenantCurrency.deleteMany({ where: { tenantId: id } });
        await prisma.tenantBank.deleteMany({ where: { tenantId: id } });

        // Delete Plaid Items (PlaidTransaction will cascade)
        await prisma.plaidItem.deleteMany({ where: { tenantId: id } });

        // Step 6: Delete the user(s) associated with the tenant
        await prisma.user.deleteMany({ where: { tenantId: id } });

        // Step 7: Finally, delete the tenant itself
        await prisma.tenant.delete({ where: { id } });
      });

      res.status(StatusCodes.NO_CONTENT).end();
    } catch (transactionError) {
      Sentry.captureException(transactionError);
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'Failed to delete tenant due to a server error during the transaction.',
        ...(process.env.NODE_ENV === 'development' && { details: transactionError.message }),
      });
    }
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
} 