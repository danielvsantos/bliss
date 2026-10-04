import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { rateLimiters } from '../../utils/rateLimit.js';
import { cors } from '../../utils/cors.js';
import { withAuth } from '../../utils/withAuth.js';
import { readActivity } from '../../utils/activityStore.js';

/**
 * GET /api/activity — processing status for the caller's tenant (#100).
 *
 * What background work (portfolio, analytics, bank sync, import, security
 * data, subscription scan, insights) is queued / running / stalled for this
 * tenant, the last 24 h of finished work, and per-type `lastCompletedAt`.
 * All roles, and read-only integration keys (MCP `get_processing_status`).
 *
 * One Redis pipeline, no Prisma, no BullMQ (see utils/activityStore.js), so the
 * web app can poll it every ~5 s while something is in flight.
 */
export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.activity(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).json({ error: `Method ${req.method} Not Allowed` });
  }

  try {
    const activity = await readActivity(req.user.tenantId);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(StatusCodes.OK).json(activity);
  } catch (error) {
    Sentry.captureException(error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Server Error' });
  }
});
