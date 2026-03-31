import { StatusCodes } from 'http-status-codes';
import prisma from '../../../prisma/prisma.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { cors } from '../../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { withAuth } from '../../../utils/withAuth.js';

/**
 * GET /api/tenants/settings
 * Returns the current tenant's AI classification thresholds, portfolio currency,
 * and Plaid history window.
 *
 * PUT /api/tenants/settings
 * Updates autoPromoteThreshold, reviewThreshold, portfolioCurrency, and/or plaidHistoryDays.
 * Thresholds must be in [0.0, 1.0]. portfolioCurrency must be in tenant's currency list.
 * plaidHistoryDays must be an integer >= 1.
 *
 * These are organisation-wide business rules, not per-user preferences.
 */
export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.accounts(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  try {
    const user = req.user;

    if (req.method === 'GET') {
      const tenant = await prisma.tenant.findUnique({
        where: { id: user.tenantId },
        select: { autoPromoteThreshold: true, reviewThreshold: true, portfolioCurrency: true, plaidHistoryDays: true },
      });
      if (!tenant) {
        return res.status(StatusCodes.NOT_FOUND).json({ error: 'Tenant not found' });
      }
      return res.status(StatusCodes.OK).json({
        autoPromoteThreshold: tenant.autoPromoteThreshold,
        reviewThreshold: tenant.reviewThreshold,
        portfolioCurrency: tenant.portfolioCurrency,
        plaidHistoryDays: tenant.plaidHistoryDays,
      });
    }

    if (req.method === 'PUT') {
      // Only admins may change organisation-wide classification thresholds
      if (user.role !== 'admin') {
        return res.status(StatusCodes.FORBIDDEN).json({ error: 'Admin access required' });
      }

      const { autoPromoteThreshold, reviewThreshold, portfolioCurrency, plaidHistoryDays } = req.body;
      const updateData = {};

      if (portfolioCurrency !== undefined) {
        // Validate against tenant's currency list
        const tenantCurrencies = await prisma.tenantCurrency.findMany({
          where: { tenantId: user.tenantId },
          select: { currencyId: true },
        });
        const validCurrencies = tenantCurrencies.map(tc => tc.currencyId);
        if (!validCurrencies.includes(portfolioCurrency)) {
          return res.status(StatusCodes.BAD_REQUEST).json({
            error: `portfolioCurrency must be one of: ${validCurrencies.join(', ')}`,
          });
        }
        updateData.portfolioCurrency = portfolioCurrency;
      }

      if (autoPromoteThreshold !== undefined) {
        const val = parseFloat(autoPromoteThreshold);
        if (isNaN(val) || val < 0 || val > 1) {
          return res.status(StatusCodes.BAD_REQUEST).json({
            error: 'autoPromoteThreshold must be a number between 0.0 and 1.0',
          });
        }
        updateData.autoPromoteThreshold = val;
      }

      if (reviewThreshold !== undefined) {
        const val = parseFloat(reviewThreshold);
        if (isNaN(val) || val < 0 || val > 1) {
          return res.status(StatusCodes.BAD_REQUEST).json({
            error: 'reviewThreshold must be a number between 0.0 and 1.0',
          });
        }
        updateData.reviewThreshold = val;
      }

      if (plaidHistoryDays !== undefined) {
        const val = parseInt(plaidHistoryDays, 10);
        if (isNaN(val) || val < 1) {
          return res.status(StatusCodes.BAD_REQUEST).json({
            error: 'plaidHistoryDays must be an integer >= 1',
          });
        }
        updateData.plaidHistoryDays = val;
      }

      if (Object.keys(updateData).length === 0) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'Provide at least one of: autoPromoteThreshold, reviewThreshold, portfolioCurrency, plaidHistoryDays',
        });
      }

      const updated = await prisma.tenant.update({
        where: { id: user.tenantId },
        data: updateData,
        select: { autoPromoteThreshold: true, reviewThreshold: true, portfolioCurrency: true, plaidHistoryDays: true },
      });

      return res.status(StatusCodes.OK).json(updated);
    }

    res.setHeader('Allow', ['GET', 'PUT']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  } catch (error) {
    Sentry.captureException(error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
