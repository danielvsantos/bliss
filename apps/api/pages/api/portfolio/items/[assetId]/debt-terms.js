import prisma from '../../../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../../../utils/cors.js';
import { rateLimiters } from '../../../../../utils/rateLimit.js';
import { Decimal } from '@prisma/client/runtime/library';
import { withAuth } from '../../../../../utils/withAuth.js';

export default withAuth(async function handler(req, res) {
  // Apply rate limiting
  await new Promise((resolve, reject) => {
    rateLimiters.portfolio(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  // Handle CORS
  if (cors(req, res)) return;

  try {
    switch (req.method) {
      case 'GET':
        await handleGet(req, res);
        break;
      case 'POST':
        await handlePost(req, res);
        break;
      case 'PUT':
        await handlePut(req, res);
        break;
      // Add PUT, GET, DELETE handlers here in the future
      default:
        res.setHeader('Allow', ['GET', 'POST', 'PUT']);
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

async function handlePost(req, res) {
  const { tenantId, email: userEmail } = req.user;
  const { assetId } = req.query;
  const portfolioItemId = parseInt(assetId, 10);

  if (isNaN(portfolioItemId)) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid Portfolio Item ID' });
  }

  const { initialBalance, interestRate, termInMonths, originationDate } = req.body;

  // --- Validation ---
  if (!initialBalance || !interestRate || !termInMonths || !originationDate) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Missing required fields: initialBalance, interestRate, termInMonths, originationDate' });
  }
  if (new Date(originationDate).toString() === 'Invalid Date') {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid originationDate format.' });
  }

  try {
    // --- Authorization Check ---
    const portfolioItem = await prisma.portfolioItem.findFirst({
      where: {
        id: portfolioItemId,
        tenantId: tenantId,
      },
      include: {
        // We need the category to check if it's a Debt asset
        category: true,
      },
    });

    if (!portfolioItem) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: 'Portfolio item not found in this tenant' });
    }
    
    // It only makes sense to add DebtTerms to a Debt asset
    if(portfolioItem.category.type !== 'Debt') {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Debt terms can only be added to assets of type "Debt"' });
    }

    // --- Upsert Operation ---
    const result = await prisma.$transaction(async (prisma) => {
      const debtTermsData = {
        initialBalance: new Decimal(initialBalance),
        interestRate: new Decimal(interestRate),
        termInMonths: parseInt(termInMonths, 10),
        originationDate: new Date(originationDate),
      };

      const upsertedDebtTerms = await prisma.debtTerms.upsert({
        where: {
          assetId: portfolioItemId,
        },
        update: debtTermsData,
        create: {
          ...debtTermsData,
          asset: {
            connect: { id: portfolioItemId },
          },
        },
      });

      // --- Auditing ---
      await prisma.auditLog.create({
        data: {
          userId: userEmail,
          action: "CREATE",
          table: "DebtTerms",
          recordId: upsertedDebtTerms.id.toString(),
          tenantId,
        },
      });

      return upsertedDebtTerms;
    });

    res.status(StatusCodes.OK).json(result);
  } catch (error) {
    Sentry.captureException(error);
    if (error.code === 'P2002') { // Unique constraint violation
      return res.status(StatusCodes.CONFLICT).json({ error: 'Debt terms already exist for this asset.' });
    }
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to create or update debt terms',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
} 

async function handleGet(req, res) {
  const { tenantId } = req.user;
  const { assetId } = req.query;
  const portfolioItemId = parseInt(assetId, 10);

  if (isNaN(portfolioItemId)) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid Portfolio Item ID' });
  }

  try {
    const debtTerms = await prisma.debtTerms.findFirst({
      where: {
        assetId: portfolioItemId,
        asset: {
          tenantId: tenantId,
        },
      },
    });

    if (!debtTerms) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: 'Debt terms not found for this item in this tenant' });
    }

    res.status(StatusCodes.OK).json(debtTerms);
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to retrieve debt terms',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
}

async function handlePut(req, res) {
    const { tenantId, email: userEmail } = req.user;
    const { assetId } = req.query;
    const portfolioItemId = parseInt(assetId, 10);

    if (isNaN(portfolioItemId)) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid Portfolio Item ID' });
    }

    const { initialBalance, interestRate, termInMonths, originationDate } = req.body;

    try {
        // --- Authorization Check ---
        const existingDebtTerms = await prisma.debtTerms.findFirst({
            where: {
                assetId: portfolioItemId,
                asset: {
                    tenantId: tenantId,
                },
            },
        });

        if (!existingDebtTerms) {
            return res.status(StatusCodes.NOT_FOUND).json({ error: 'Debt terms not found for this item in this tenant' });
        }

        // --- Update Operation ---
        const result = await prisma.$transaction(async (prisma) => {
            const debtTermsData = {
                initialBalance: initialBalance ? new Decimal(initialBalance) : undefined,
                interestRate: interestRate ? new Decimal(interestRate) : undefined,
                termInMonths: termInMonths ? parseInt(termInMonths, 10) : undefined,
                originationDate: originationDate ? new Date(originationDate) : undefined,
            };

            const updatedDebtTerms = await prisma.debtTerms.update({
                where: {
                    id: existingDebtTerms.id,
                },
                data: debtTermsData,
            });

            // --- Auditing ---
            await prisma.auditLog.create({
                data: {
                    userId: userEmail,
                    action: "UPDATE",
                    table: "DebtTerms",
                    recordId: updatedDebtTerms.id.toString(),
                    tenantId,
                },
            });

            return updatedDebtTerms;
        });

        res.status(StatusCodes.OK).json(result);
    } catch (error) {
        Sentry.captureException(error);
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
            error: 'Failed to update debt terms',
            ...(process.env.NODE_ENV === 'development' && { details: error.message }),
        });
    }
} 