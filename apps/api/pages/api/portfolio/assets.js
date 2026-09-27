import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../utils/cors.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { withAuth } from '../../../utils/withAuth.js';
import { listAssets, parseListQuery, ValidationError } from '../../../services/manageAssets.service.js';

/**
 * GET /api/portfolio/assets — Manage Assets list (#81).
 *
 * Query: type (category group or processingHint), accountId, assetClass,
 * search, status, includeClosed, id, cursor, limit (default 50, max 100).
 * All filtering happens here; see services/manageAssets.service.js.
 */
export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.portfolio(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  let query;
  try {
    query = parseListQuery(req.query);
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: error.message });
    }
    throw error;
  }

  try {
    const result = await listAssets(req.user.tenantId, query);
    return res.status(StatusCodes.OK).json(result);
  } catch (error) {
    Sentry.captureException(error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
