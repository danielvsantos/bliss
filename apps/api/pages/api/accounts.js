import prisma from '../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../utils/cors.js';
import { rateLimiters } from '../../utils/rateLimit.js';
import { withAuth } from '../../utils/withAuth.js';

export default withAuth(async function handler(req, res) {
  // Apply rate limiting
  await new Promise((resolve, reject) => {
    rateLimiters.accounts(req, res, (result) => {
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
      case 'POST':
        await handlePost(req, res, user);
        break;
      case 'PUT':
        await handlePut(req, res, user);
        break;
      case 'DELETE':
        await handleDelete(req, res, user);
        break;
      default:
        res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
        res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
        break;
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
  const tenantId = user.tenantId;
  const { 
    id, 
    countryId, 
    currencyCode, 
    ownerId,
    page = 1, 
    limit = 100,
    sortBy = 'name',
    sortOrder = 'asc'
  } = req.query;

  if (!tenantId) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Tenant ID missing from user.' });
    return;
  }

  if (id) {
    const account = await prisma.account.findUnique({
      where: { id: parseInt(id, 10) },
      include: { 
        owners: { include: { user: { select: { email: true } } } },
        country: true,
        currency: true,
        bank: true
      }
    });

    if (!account || account.tenantId !== tenantId) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Account not found in this tenant' });
      return;
    }

    res.status(StatusCodes.OK).json(account);
    return;
  }

  // Build filter conditions
  const filters = {
    tenantId,
    ...(countryId && { countryId }),
    ...(currencyCode && { currencyCode: currencyCode.toUpperCase() }),
    ...(ownerId && {
      owners: {
        some: { userId: ownerId }
      }
    })
  };

  // Parse pagination parameters
  const numericPage = Math.max(parseInt(page, 10), 1);
  const numericLimit = Math.min(parseInt(limit, 10), 1000);
  const skip = (numericPage - 1) * numericLimit;

  // Validate sort parameters
  const allowedSortFields = ['name', 'accountNumber'];
  const actualSortField = allowedSortFields.includes(sortBy) ? sortBy : 'name';
  const actualSortOrder = sortOrder === 'desc' ? 'desc' : 'asc';

  try {
    // Get filtered accounts with pagination
    const [accounts, total] = await Promise.all([
      prisma.account.findMany({
        where: filters,
        include: { 
          owners: { include: { user: { select: { email: true } } } },
          country: true,
          currency: true,
          bank: true
        },
        orderBy: { [actualSortField]: actualSortOrder },
        skip,
        take: numericLimit,
      }),
      prisma.account.count({ where: filters })
    ]);

    res.status(StatusCodes.OK).json({
      accounts,
      total,
      page: numericPage,
      limit: numericLimit,
      totalPages: Math.ceil(total / numericLimit),
      filters: {
        countryId,
        currencyCode,
        ownerId
      },
      sort: {
        field: actualSortField,
        order: actualSortOrder
      }
    });
    return;
  } catch (error) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Query Failed',
      details: error.message
    });
  }
}

const ACCOUNT_NAME_MAX = 100;

async function handlePost(req, res, user) {
  const tenantId = user.tenantId;
  const { name, accountNumber, bankId, currencyCode, countryId, ownerIds } = req.body || {};

  if (!name || !accountNumber || !bankId || !currencyCode || !countryId) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Missing required fields',
      details: 'name, accountNumber, bankId, currencyCode and countryId are required'
    });
    return;
  }

  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName || trimmedName.length > ACCOUNT_NAME_MAX) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: `Account name must be between 1 and ${ACCOUNT_NAME_MAX} characters`
    });
    return;
  }

  if (typeof accountNumber !== 'string' || typeof currencyCode !== 'string' || typeof countryId !== 'string') {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Invalid input',
      details: 'accountNumber, currencyCode and countryId must be strings'
    });
    return;
  }

  if (ownerIds !== undefined && !Array.isArray(ownerIds)) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid owner IDs', details: 'ownerIds must be an array' });
    return;
  }

  const parsedBankId = parseInt(bankId, 10);
  if (isNaN(parsedBankId)) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid bankId format. Must be an integer.' });
    return;
  }

  const upperCurrency = currencyCode.toUpperCase();
  const upperCountry = countryId.toUpperCase();

  // Validate that the currency, country, and BANK exist and are available to the tenant
  const [validCurrency, validCountry, validTenantBank] = await Promise.all([
    prisma.tenantCurrency.findFirst({
      where: { tenantId, currencyId: upperCurrency }
    }),
    prisma.tenantCountry.findFirst({
      where: { tenantId, countryId: upperCountry }
    }),
    // Check if the bank is linked to THIS tenant
    prisma.tenantBank.findUnique({
      where: { 
        tenantId_bankId: { // Use the composite key name
          tenantId: tenantId, 
          bankId: parsedBankId 
        }
      }
    })
  ]);

  const errors = {};
  if (!validCurrency) errors.currency = 'Currency not available for this tenant';
  if (!validCountry) errors.country = 'Country not available for this tenant';
  // Update bank validation message
  if (!validTenantBank) errors.bankId = 'Selected bank is not enabled for this tenant.';

  if (Object.keys(errors).length > 0) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Invalid input',
      details: errors
    });
    return;
  }

  // Owners default to the acting user (#98). For an integration token that is
  // the admin who created it; the id is only used for the AccountOwner insert,
  // never to re-read that user's row or role.
  const owners = ownerIds && ownerIds.length > 0 ? ownerIds : [user.id];

  if (ownerIds && ownerIds.length > 0) {
    // Validate that all supplied owners exist and belong to the tenant
    const validUsers = await prisma.user.findMany({
      where: {
        id: { in: ownerIds },
        tenantId
      },
      select: { id: true }
    });

    if (validUsers.length !== new Set(ownerIds).size) {
      res.status(StatusCodes.BAD_REQUEST).json({ 
        error: 'Invalid owner IDs',
        details: 'Some users do not exist in this tenant'
      });
      return;
    }
  }

  // Integration callers (MCP agents, scripts) retry: refuse a second account
  // with the same bank + currency + name (#98). Best-effort, not a unique
  // index: the in-app onboarding legitimately names several accounts after
  // their bank, so session callers are not checked.
  if (user.authType === 'integration') {
    const existing = await prisma.account.findFirst({
      where: {
        tenantId,
        bankId: parsedBankId,
        currencyCode: upperCurrency,
        name: { equals: trimmedName, mode: 'insensitive' }
      },
      select: { id: true }
    });
    if (existing) {
      res.status(StatusCodes.CONFLICT).json({
        error: 'ACCOUNT_EXISTS',
        code: 'ACCOUNT_EXISTS',
        accountId: existing.id,
        details: { accountId: existing.id }
      });
      return;
    }
  }

  // Create account and audit log in a transaction
  const result = await prisma.$transaction(async (prisma) => {
    const newAccount = await prisma.account.create({
      data: {
        name: trimmedName,
        accountNumber,
        bankId: parsedBankId,
        currencyCode: upperCurrency,
        countryId: upperCountry,
        tenantId,
        owners: {
          create: [...new Set(owners)].map(userId => ({ userId }))
        }
      },
      include: { 
        owners: { include: { user: { select: { id: true, email: true } } } },
        country: true,
        currency: true,
        bank: true
      }
    });

    return newAccount;
  });

  // The full account number is never echoed back on create (#98); the GETs
  // are unchanged.
  const { accountNumber: storedNumber, ...account } = result;
  const number = typeof storedNumber === 'string' ? storedNumber : accountNumber;
  res.status(StatusCodes.CREATED).json({ ...account, accountNumberLast4: number.slice(-4) });
  return;
}

async function handlePut(req, res, user) {
  const tenantId = user.tenantId;
  const { id } = req.query;
  const { name, accountNumber, bankId, currencyCode, countryId, ownerIds } = req.body;

  if (!id) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Account ID must be provided in the query.' });
    return;
  }

  const accountId = parseInt(id, 10);
  if (isNaN(accountId)) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid account ID format' });
    return;
  }

  // Fetch existing account *first* to get its current bankId if needed
  const existingAccount = await prisma.account.findUnique({
    where: { id: accountId },
    select: { tenantId: true, bankId: true, owners: { select: { userId: true } } } // Select necessary fields
  });

  if (!existingAccount || existingAccount.tenantId !== tenantId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: 'Account not found in this tenant' });
    return;
  }

  let parsedBankId = existingAccount.bankId; // Keep existing if not provided
  let bankValidationNeeded = false;

  // --- Start Pre-transaction Validation ---
  const validationPromises = [];

  // Validate bank if provided and different
  if (bankId !== undefined) {
    parsedBankId = parseInt(bankId, 10);
    if (isNaN(parsedBankId)) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid bankId format. Must be an integer.' });
      return;
    }
    if (parsedBankId !== existingAccount.bankId) {
      bankValidationNeeded = true;
      validationPromises.push(
        prisma.tenantBank.findUnique({ where: { tenantId_bankId: { tenantId, bankId: parsedBankId } } })
      );
    } else {
        validationPromises.push(Promise.resolve(true)); // Bank didn't change, placeholder
    }
  } else {
    validationPromises.push(Promise.resolve(true)); // Bank not provided, placeholder
  }

  // Validate country if provided and different
  if (countryId && countryId.toUpperCase() !== existingAccount.countryId) {
     validationPromises.push(prisma.tenantCountry.findFirst({ where: { tenantId, countryId: countryId.toUpperCase() } }));
  } else {
    validationPromises.push(Promise.resolve(true)); // Placeholder
  }

  // Validate currency if provided and different
  if (currencyCode && currencyCode.toUpperCase() !== existingAccount.currencyCode) {
     validationPromises.push(prisma.tenantCurrency.findFirst({ where: { tenantId, currencyId: currencyCode.toUpperCase() } }));
  } else {
     validationPromises.push(Promise.resolve(true)); // Placeholder
  }
  
  // Validate owners if provided
  if (ownerIds !== undefined && Array.isArray(ownerIds)) {
     validationPromises.push(prisma.user.findMany({ where: { id: { in: ownerIds }, tenantId } }));
  } else {
      validationPromises.push(Promise.resolve(null)); // Placeholder for users check
  }

  const [bankCheckResult, countryCheckResult, currencyCheckResult, ownerCheckResult] = await Promise.all(validationPromises);

  const errors = {};
  if (bankValidationNeeded && !bankCheckResult) errors.bankId = 'Selected bank is not enabled for this tenant.';
  if (countryId && !countryCheckResult) errors.country = 'Country not available for this tenant';
  if (currencyCode && !currencyCheckResult) errors.currency = 'Currency not available for this tenant';
  if (ownerCheckResult && ownerCheckResult.length !== ownerIds.length) errors.ownerIds = 'Some owner users do not exist in this tenant';
  
  if (Object.keys(errors).length > 0) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Invalid input',
      details: errors
    });
    return;
  }
  // --- End Pre-transaction Validation ---

  // Prepare update data (use validated/parsed values)
  const updateData = {};
  if (name !== undefined) updateData.name = name;
  if (accountNumber !== undefined) updateData.accountNumber = accountNumber;
  if (currencyCode !== undefined) updateData.currencyCode = currencyCode.toUpperCase();
  if (countryId !== undefined) updateData.countryId = countryId.toUpperCase();
  if (bankId !== undefined) updateData.bankId = parsedBankId; // Use the parsed ID

  // Handle owner updates if ownerIds is provided
  let ownerUpdates = {};
  if (ownerIds !== undefined && Array.isArray(ownerIds)) {
    const currentOwnerIds = existingAccount.owners.map(o => o.userId);
    const ownersToAdd = ownerIds.filter(id => !currentOwnerIds.includes(id));
    const ownersToRemove = currentOwnerIds.filter(id => !ownerIds.includes(id));

    ownerUpdates = {
      // Need to handle disconnect/connect or deleteMany/createMany
      // Using deleteMany/createMany for simplicity here
      deleteMany: { userId: { in: ownersToRemove } }, 
      create: ownersToAdd.map(userId => ({ userId }))
    };
  }

  // Update account and audit log in a transaction
  const result = await prisma.$transaction(async (prisma) => {
    // Only update owners if there are changes
    if (Object.keys(ownerUpdates).length > 0) {
        if (ownerUpdates.deleteMany?.userId?.in?.length > 0) {
            await prisma.accountOwner.deleteMany({ where: { accountId: accountId, userId: ownerUpdates.deleteMany.userId } });
        }
        if (ownerUpdates.create?.length > 0) {
             await prisma.accountOwner.createMany({ data: ownerUpdates.create.map(o => ({...o, accountId })) });
        }
    }

    // Update the main account data
    const updatedAccount = await prisma.account.update({
      where: { id: accountId },
      data: updateData, // Only include fields that were actually provided
      include: {
        owners: { include: { user: true } },
        country: true,
        currency: true,
        bank: true 
      }
    });

    return updatedAccount;
  });

  res.status(StatusCodes.OK).json(result);
  return;
}

async function handleDelete(req, res, user) {
  const tenantId = user.tenantId;
  const { id } = req.query;

  if (!id) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Account ID must be provided.' });
    return;
  }

  const accountId = parseInt(id, 10);
  const existingAccount = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      tenantId: true,
      plaidItemId: true,
      plaidAccountId: true,
      plaidItem: { select: { status: true } },
    },
  });

  if (!existingAccount || existingAccount.tenantId !== tenantId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: 'Account not found in this tenant' });
    return;
  }

  // Plaid guard — a still-connected bank link must be disconnected first, otherwise
  // the next plaidSyncWorker run is free to recreate the deleted account.
  // Checked before the transaction guard so a connected Plaid account with
  // transactions is told to disconnect first (the required first step).
  if (existingAccount.plaidItemId && existingAccount.plaidItem?.status !== 'REVOKED') {
    res.status(StatusCodes.CONFLICT).json({
      error: 'Cannot delete a connected bank account',
      reason: 'PLAID_CONNECTED',
      details: 'Disconnect this bank connection before deleting the account.',
    });
    return;
  }

  // Check if account has any transactions
  const transactionCount = await prisma.transaction.count({
    where: { accountId }
  });

  if (transactionCount > 0) {
    res.status(StatusCodes.CONFLICT).json({
      error: 'Cannot delete account with transactions',
      reason: 'HAS_TRANSACTIONS',
      transactionCount,
      details: `Account has ${transactionCount} associated transaction(s). Please delete them first or re-assign them.`
    });
    return;
  }

  // Delete account (and clean up any orphan Plaid rows) in a transaction.
  await prisma.$transaction(async (tx) => {
    // A disconnected (REVOKED) Plaid account leaves PlaidTransaction rows behind —
    // PlaidTransaction has no FK to Account, so nothing cascades. Remove the rows
    // scoped to this account's Plaid identity before deleting the account.
    if (existingAccount.plaidItemId && existingAccount.plaidAccountId) {
      await tx.plaidTransaction.deleteMany({
        where: {
          plaidItemId: existingAccount.plaidItemId,
          plaidAccountId: existingAccount.plaidAccountId,
        },
      });
    }

    // Delete all account owners first (AccountOwner has no onDelete cascade)
    await tx.accountOwner.deleteMany({
      where: { accountId }
    });

    // Delete the account. PortfolioItem.accountId is set to null automatically
    // by the schema's onDelete: SetNull — holdings survive, unlinked.
    await tx.account.delete({
      where: { id: accountId }
    });

  });

  res.status(StatusCodes.NO_CONTENT).end();
  return;
}
