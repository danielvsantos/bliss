import { StatusCodes } from 'http-status-codes';
import prisma from '../../../../prisma/prisma.js';
import { rateLimiters } from '../../../../utils/rateLimit.js';
import { cors } from '../../../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { withAuth } from '../../../../utils/withAuth.js';

const VALID_AMOUNT_STRATEGIES = ['SINGLE_SIGNED', 'DEBIT_CREDIT_COLUMNS', 'AMOUNT_WITH_TYPE'];

/**
 * PUT  /api/imports/adapters/:id — Update a tenant-scoped adapter
 * DELETE /api/imports/adapters/:id — Soft-delete a tenant-scoped adapter
 *
 * Global adapters (tenantId = null) cannot be modified or deleted.
 */
export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.importsAdapters(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  try {
    const user = req.user;

    const adapterId = parseInt(req.query.id, 10);
    if (isNaN(adapterId)) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid adapter ID' });
    }

    // Fetch adapter and verify ownership
    const adapter = await prisma.importAdapter.findUnique({ where: { id: adapterId } });

    if (!adapter || !adapter.isActive) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: 'Adapter not found' });
    }

    // Block modifications to global adapters
    if (adapter.tenantId === null) {
      return res.status(StatusCodes.FORBIDDEN).json({ error: 'Global adapters cannot be modified' });
    }

    if (adapter.tenantId !== user.tenantId) {
      return res.status(StatusCodes.FORBIDDEN).json({ error: 'Access denied' });
    }

    if (req.method === 'DELETE') {
      await prisma.importAdapter.update({
        where: { id: adapterId },
        data: { isActive: false },
      });
      return res.status(StatusCodes.NO_CONTENT).end();
    }

    if (req.method === 'PUT') {
      const { name, matchSignature, columnMapping, dateFormat, amountStrategy, currencyDefault, skipRows } = req.body;
      const updateData = {};

      if (name !== undefined) {
        if (typeof name !== 'string' || name.length < 2 || name.length > 100) {
          return res.status(StatusCodes.BAD_REQUEST).json({ error: 'name must be 2-100 characters' });
        }
        updateData.name = name;
      }

      if (matchSignature !== undefined) {
        if (!Array.isArray(matchSignature.headers) || matchSignature.headers.length === 0) {
          return res.status(StatusCodes.BAD_REQUEST).json({ error: 'matchSignature.headers must be a non-empty array' });
        }
        updateData.matchSignature = matchSignature;
      }

      if (columnMapping !== undefined) {
        if (!columnMapping.date) {
          return res.status(StatusCodes.BAD_REQUEST).json({ error: 'columnMapping.date is required' });
        }
        if (!columnMapping.description) {
          return res.status(StatusCodes.BAD_REQUEST).json({ error: 'columnMapping.description is required' });
        }
        updateData.columnMapping = columnMapping;
      }

      if (amountStrategy !== undefined) {
        if (!VALID_AMOUNT_STRATEGIES.includes(amountStrategy)) {
          return res.status(StatusCodes.BAD_REQUEST).json({
            error: `amountStrategy must be one of: ${VALID_AMOUNT_STRATEGIES.join(', ')}`,
          });
        }
        const mapping = columnMapping ?? adapter.columnMapping;
        if (amountStrategy === 'DEBIT_CREDIT_COLUMNS' && (!mapping.debit || !mapping.credit)) {
          return res.status(StatusCodes.BAD_REQUEST).json({
            error: 'columnMapping.debit and columnMapping.credit are required for DEBIT_CREDIT_COLUMNS',
          });
        }
        if ((amountStrategy === 'SINGLE_SIGNED' || amountStrategy === 'AMOUNT_WITH_TYPE') && !mapping.amount) {
          return res.status(StatusCodes.BAD_REQUEST).json({
            error: 'columnMapping.amount is required for this amountStrategy',
          });
        }
        updateData.amountStrategy = amountStrategy;
      }

      if (dateFormat !== undefined) updateData.dateFormat = dateFormat || null;
      if (currencyDefault !== undefined) updateData.currencyDefault = currencyDefault || null;
      if (skipRows !== undefined) updateData.skipRows = skipRows || 0;

      if (Object.keys(updateData).length === 0) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'No update fields provided' });
      }

      const updated = await prisma.importAdapter.update({
        where: { id: adapterId },
        data: updateData,
      });

      return res.status(StatusCodes.OK).json({ adapter: updated });
    }

    res.setHeader('Allow', ['PUT', 'DELETE']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  } catch (error) {
    Sentry.captureException(error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      details: error.message,
    });
  }
});
