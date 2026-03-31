import prisma from '../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import { cors } from '../../../utils/cors.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import * as Sentry from '@sentry/nextjs';
import { withAuth } from '../../../utils/withAuth.js';

export default withAuth(async function handler(req, res) {
  // Apply rate limiting by wrapping middleware in a Promise
  await new Promise((resolve, reject) => {
    rateLimiters.portfolio(req, res, (result) => {
      if (result instanceof Error) {
        return reject(result);
      }
      return resolve(result);
    });
  });
  
  if (cors(req, res)) return;

  try {
    switch (req.method) {
      case 'GET':
        await handleGet(req, res);
        break;
      default:
        res.setHeader('Allow', ['GET']);
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

async function handleGet(req, res) {
  const { tenantId } = req.user;
  const { account, category, categoryGroup, ticker, page = '1', pageSize = '100' } = req.query;

  const pageNum = parseInt(page, 10);
  const pageSizeNum = parseInt(pageSize, 10);

  // Build the 'where' clause for filtering based on the related PortfolioItem
  const whereClause = {
    asset: { // Note: 'asset' is the relation field name in PortfolioHolding model
      tenantId: tenantId,
      ...(ticker && { symbol: ticker }),
      ...(category && { category: { name: category } }),
      ...(categoryGroup && { category: { group: categoryGroup } }),
    },
  };

  try {
    const totalCount = await prisma.portfolioHolding.count({ where: whereClause });
    const holdings = await prisma.portfolioHolding.findMany({
      where: whereClause,
      take: pageSizeNum,
      skip: (pageNum - 1) * pageSizeNum,
      include: {
        asset: {
          include: {
            category: true,
          }
        }
      },
      orderBy: {
        asset: {
          symbol: 'asc'
        }
      },
    });

    res.status(StatusCodes.OK).json({
      pagination: {
        page: pageNum,
        pageSize: pageSizeNum,
        totalCount,
        totalPages: Math.ceil(totalCount / pageSizeNum),
      },
      data: holdings,
    });
  } catch (dbError) {
    Sentry.captureException(dbError);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: "An error occurred while fetching portfolio holdings.",
      details: dbError.message
    });
  }
} 