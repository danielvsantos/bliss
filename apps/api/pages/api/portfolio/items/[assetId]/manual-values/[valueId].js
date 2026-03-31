import prisma from '../../../../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../../../../utils/cors.js';
import { rateLimiters } from '../../../../../../utils/rateLimit.js';
import { Decimal } from '@prisma/client/runtime/library';
import { produceEvent } from '../../../../../../utils/produceEvent.js';
import { withAuth } from '../../../../../../utils/withAuth.js';

export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.assetprice(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  try {
    switch (req.method) {
      case 'PUT':
        await handlePut(req, res);
        break;
      case 'DELETE':
        await handleDelete(req, res);
        break;
      default:
        res.setHeader('Allow', ['PUT', 'DELETE']);
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

async function handlePut(req, res) {
    const { tenantId, email: userEmail } = req.user;
    const { valueId } = req.query; 
    const { date, value, currency, notes } = req.body;
  
    try {
      const existingValue = await prisma.manualAssetValue.findFirst({
        where: { id: valueId, tenantId },
      });
  
      if (!existingValue) {
        return res.status(StatusCodes.NOT_FOUND).json({ error: 'Manual value record not found in this tenant' });
      }
  
      const result = await prisma.$transaction(async (prisma) => {
        const updatedValue = await prisma.manualAssetValue.update({
          where: { id: valueId },
          data: {
            date: date ? new Date(date) : undefined,
            value: value !== undefined ? new Decimal(value) : undefined,
            currency: currency,
            notes: notes,
          },
        });
  
        await prisma.auditLog.create({
          data: {
            userId: userEmail,
            action: 'UPDATE',
            table: 'ManualAssetValue',
            recordId: updatedValue.id.toString(),
            tenantId,
          },
        });
  
        return updatedValue;
      });
  
      await produceEvent({
          type: 'MANUAL_PORTFOLIO_PRICE_UPDATED',
          portfolioItemId: existingValue.assetId,
          tenantId: tenantId,
      });

      res.status(StatusCodes.OK).json(result);
    } catch (error) {
      Sentry.captureException(error);
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Update failed', details: error.message });
    }
  }
  
  async function handleDelete(req, res) {
    const { tenantId, email: userEmail } = req.user;
    const { valueId } = req.query;
  
    try {
      const existingValue = await prisma.manualAssetValue.findFirst({
        where: { id: valueId, tenantId },
      });
  
      if (!existingValue) {
        return res.status(StatusCodes.NOT_FOUND).json({ error: 'Manual value record not found in this tenant' });
      }
  
      await prisma.$transaction(async (prisma) => {
        await prisma.manualAssetValue.delete({
          where: { id: valueId },
        });
  
        await prisma.auditLog.create({
          data: {
            userId: userEmail,
            action: 'DELETE',
            table: 'ManualAssetValue',
            recordId: valueId.toString(),
            tenantId,
          },
        });
      });
  
      await produceEvent({
          type: 'MANUAL_PORTFOLIO_PRICE_UPDATED',
          portfolioItemId: existingValue.assetId,
          tenantId: tenantId,
      });

      res.status(StatusCodes.NO_CONTENT).end();
    } catch (error) {
      Sentry.captureException(error);
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Deletion failed', details: error.message });
    }
  } 