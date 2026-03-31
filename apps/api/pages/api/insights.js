import { StatusCodes } from 'http-status-codes';
import prisma from '../../prisma/prisma.js';
import { rateLimiters } from '../../utils/rateLimit.js';
import { cors } from '../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { withAuth } from '../../utils/withAuth.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const BACKEND_API_KEY = process.env.INTERNAL_API_KEY;

/**
 * GET /api/insights
 * Returns insights for the current tenant.
 * Query params: limit, offset, lens, severity, includeDismissed
 *
 * PUT /api/insights
 * Dismiss/restore an insight. Body: { insightId, dismissed }
 *
 * POST /api/insights
 * Trigger on-demand insight generation. Fire-and-forget to backend service.
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
      const {
        limit = '20',
        offset = '0',
        lens,
        severity,
        includeDismissed = 'false',
      } = req.query;

      const where = {
        tenantId: user.tenantId,
        ...(lens && { lens }),
        ...(severity && { severity }),
        ...(includeDismissed !== 'true' && { dismissed: false }),
      };

      const [insights, total, latestInsight] = await Promise.all([
        prisma.insight.findMany({
          where,
          orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
          take: parseInt(limit, 10),
          skip: parseInt(offset, 10),
        }),
        prisma.insight.count({ where }),
        prisma.insight.findFirst({
          where: { tenantId: user.tenantId },
          orderBy: { createdAt: 'desc' },
          select: { date: true },
        }),
      ]);

      return res.status(StatusCodes.OK).json({
        insights,
        total,
        latestBatchDate: latestInsight?.date || null,
      });
    }

    if (req.method === 'PUT') {
      const { insightId, dismissed } = req.body;

      if (!insightId || typeof dismissed !== 'boolean') {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'insightId and dismissed (boolean) are required',
        });
      }

      // Verify the insight belongs to this tenant
      const insight = await prisma.insight.findFirst({
        where: { id: insightId, tenantId: user.tenantId },
      });

      if (!insight) {
        return res.status(StatusCodes.NOT_FOUND).json({ error: 'Insight not found' });
      }

      const updated = await prisma.insight.update({
        where: { id: insightId },
        data: { dismissed },
      });

      return res.status(StatusCodes.OK).json(updated);
    }

    if (req.method === 'POST') {
      // Fire-and-forget to backend service
      try {
        fetch(`${BACKEND_URL}/api/insights/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': BACKEND_API_KEY,
          },
          body: JSON.stringify({ tenantId: user.tenantId }),
        }).catch((err) => {
          // Log but don't throw — fire-and-forget
          Sentry.captureException(err);
        });
      } catch {
        // Ignore — fire-and-forget
      }

      return res.status(StatusCodes.ACCEPTED).json({
        message: 'Insight generation started',
      });
    }

    res.setHeader('Allow', ['GET', 'PUT', 'POST']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  } catch (error) {
    Sentry.captureException(error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
