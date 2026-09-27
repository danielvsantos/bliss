import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../utils/cors.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { withAuth } from '../../../utils/withAuth.js';
import { getPassiveIncome, parseHorizon } from '../../../services/passiveIncome.service.js';

/**
 * GET /api/portfolio/passive-income?horizon=12|24|36
 *
 * Projected passive income (dividends, coupons, rent, cash interest and
 * allowance/benefit streams) for the next `horizon` months next to the last
 * 12 months of actual "Passive Income" group income. Computed on request by
 * `@bliss/shared/portfolio`'s `project()`; see services/passiveIncome.service.js.
 */
export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.portfolio(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      return resolve(result);
    });
  });

  if (cors(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  const horizon = parseHorizon(req.query.horizon);
  if (horizon == null) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'horizon must be one of: 12, 24, 36' });
  }

  try {
    const payload = await getPassiveIncome(req.user.tenantId, { horizon });
    return res.status(StatusCodes.OK).json(payload);
  } catch (error) {
    Sentry.captureException(error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
