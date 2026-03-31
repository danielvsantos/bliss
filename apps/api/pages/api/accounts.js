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

async function handlePost(req, res, user) {
  const tenantId = user.tenantId;
  const { name, accountNumber, bankId, currencyCode, countryId, ownerIds = [] } = req.body;

  if (!name || !accountNumber || !bankId || !currencyCode || !countryId || ownerIds.length === 0) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Missing required fields',
      details: 'name, bankId, currencyCode, and countryId are required'
    });
    return;
  }

  const parsedBankId = parseInt(bankId, 10);
  if (isNaN(parsedBankId)) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid bankId format. Must be an integer.' });
    return;
  }

  // Validate that the currency, country, and BANK exist and are available to the tenant
  const [validCurrency, validCountry, validTenantBank] = await Promise.all([
    prisma.tenantCurrency.findFirst({
      where: { tenantId, currencyId: currencyCode.toUpperCase() }
    }),
    prisma.tenantCountry.findFirst({
      where: { tenantId, countryId: countryId.toUpperCase() }
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

  // Validate that all owners exist and belong to the tenant
  const validUsers = await prisma.user.findMany({
    where: {
      id: { in: ownerIds },
      tenantId
    }
  });

  if (validUsers.length !== ownerIds.length) {
    res.status(StatusCodes.BAD_REQUEST).json({ 
      error: 'Invalid owner IDs',
      details: 'Some users do not exist in this tenant'
    });
    return;
  }

  // Create account and audit log in a transaction
  const result = await prisma.$transaction(async (prisma) => {
    const newAccount = await prisma.account.create({
      data: {
        name,
        accountNumber,
        bankId: parsedBankId,
        currencyCode: currencyCode.toUpperCase(),
        countryId: countryId.toUpperCase(),
        tenantId,
        owners: {
          create: ownerIds.map(userId => ({ userId }))
        }
      },
      include: { 
        owners: { include: { user: true } },
        country: true,
        currency: true,
        bank: true
      }
    });

    await prisma.auditLog.create({
      data: {
        userId: user.email,
        action: "CREATE",
        table: "Account",
        recordId: newAccount.id.toString(),
        tenantId
      },
    });

    return newAccount;
  });

  res.status(StatusCodes.CREATED).json(result);
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

    await prisma.auditLog.create({
      data: {
        userId: user.email,
        action: "UPDATE",
        table: "Account",
        recordId: accountId.toString(), // Use accountId variable
        tenantId
      },
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
    where: { id: accountId }
  });

  if (!existingAccount || existingAccount.tenantId !== tenantId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: 'Account not found in this tenant' });
    return;
  }

  // Check if account has any transactions
  const transactionCount = await prisma.transaction.count({
    where: { accountId }
  });

  if (transactionCount > 0) {
    res.status(StatusCodes.CONFLICT).json({
      error: 'Cannot delete account with transactions',
      details: `Account has ${transactionCount} associated transaction(s). Please delete them first or re-assign them.`
    });
    return;
  }

  // Delete account and create audit log in a transaction
  await prisma.$transaction(async (prisma) => {
    // Delete all account owners first
    await prisma.accountOwner.deleteMany({
      where: { accountId }
    });

    // Delete the account
    await prisma.account.delete({
      where: { id: accountId }
    });

    // Create audit log
    await prisma.auditLog.create({
      data: {
        userId: user.email,
        action: "DELETE",
        table: "Account",
        recordId: id.toString(),
        tenantId
      },
    });
  });

  res.status(StatusCodes.NO_CONTENT).end();
  return;
}
