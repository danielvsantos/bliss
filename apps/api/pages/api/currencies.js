import prisma from '../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../utils/cors';
import { rateLimiters } from '../../utils/rateLimit';

export default async function handler(req, res) {
  // This endpoint lists global reference data, so typically no auth is needed.
  // If you want to restrict access, add getToken and tenant/user checks here.


  // Apply rate limiting
  await new Promise((resolve, reject) => {
    rateLimiters.currencies(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  
  // Handle CORS
  if (cors(req, res)) return;

  switch (req.method) {
    case 'GET':
      try {
        const currencies = await prisma.currency.findMany({
          select: {
            id: true,
            name: true,
            symbol: true
          },
          orderBy: {
            name: 'asc' // Order currencies alphabetically
          }
        });
        res.status(StatusCodes.OK).json(currencies);
        return;
      } catch (error) {
        Sentry.captureException(error);
        console.error("Error fetching currencies:", error);
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
          error: 'Failed to fetch currencies',
          ...(process.env.NODE_ENV === 'development' && { details: error.message }),
        });
        return;
      }
    default:
      res.setHeader('Allow', ['GET']);
      res.status(StatusCodes.METHOD_NOT_ALLOWED).json({ error: `Method ${req.method} Not Allowed` });
      return;
  }
} 