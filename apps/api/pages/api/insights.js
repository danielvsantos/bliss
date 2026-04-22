import { StatusCodes } from 'http-status-codes';
import prisma from '../../prisma/prisma.js';
import { rateLimiters } from '../../utils/rateLimit.js';
import { cors } from '../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { withAuth } from '../../utils/withAuth.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const BACKEND_API_KEY = process.env.INTERNAL_API_KEY;

const VALID_TIERS = ['MONTHLY', 'QUARTERLY', 'ANNUAL', 'PORTFOLIO'];
const VALID_CATEGORIES = ['SPENDING', 'INCOME', 'SAVINGS', 'PORTFOLIO', 'DEBT', 'NET_WORTH'];

/**
 * GET /api/insights
 * Returns insights for the current tenant.
 * Query params: limit, offset, lens, severity, tier, category, periodKey, includeDismissed, latestOnly
 *
 * PUT /api/insights
 * Dismiss/restore an insight. Body: { insightId, dismissed }
 *
 * POST /api/insights
 * Trigger on-demand insight generation. Fire-and-forget to backend service.
 * Body: { tier?, year?, month?, quarter?, periodKey?, force? }
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
        tier,
        category,
        periodKey,
        includeDismissed = 'false',
        latestOnly = 'false',
      } = req.query;

      const where = {
        tenantId: user.tenantId,
        ...(lens && { lens }),
        ...(severity && { severity }),
        ...(tier && VALID_TIERS.includes(tier) && { tier }),
        ...(category && VALID_CATEGORIES.includes(category) && { category }),
        ...(periodKey && { periodKey }),
        ...(includeDismissed !== 'true' && { dismissed: false }),
      };

      // If latestOnly, get only the latest batch per tier
      let orderBy = [{ priority: 'desc' }, { createdAt: 'desc' }];

      const [insights, total, latestByTier] = await Promise.all([
        prisma.insight.findMany({
          where,
          orderBy,
          take: parseInt(limit, 10),
          skip: parseInt(offset, 10),
        }),
        prisma.insight.count({ where }),
        // Get the latest batch date per tier for this tenant
        prisma.insight.groupBy({
          by: ['tier'],
          where: { tenantId: user.tenantId },
          _max: { date: true, createdAt: true },
        }),
      ]);

      // Build a summary of latest batches per tier
      const tierSummary = {};
      for (const entry of latestByTier) {
        tierSummary[entry.tier] = {
          latestDate: entry._max.date,
          latestCreatedAt: entry._max.createdAt,
        };
      }

      // Get category counts for the filter UI
      const categoryCounts = await prisma.insight.groupBy({
        by: ['category'],
        where: {
          tenantId: user.tenantId,
          ...(includeDismissed !== 'true' && { dismissed: false }),
        },
        _count: { id: true },
      });

      return res.status(StatusCodes.OK).json({
        insights,
        total,
        tierSummary,
        categoryCounts: categoryCounts.reduce((acc, c) => {
          acc[c.category] = c._count.id;
          return acc;
        }, {}),
      });
    }

    if (req.method === 'PUT') {
      const { insightId, dismissed } = req.body;

      if (!insightId || typeof dismissed !== 'boolean') {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'insightId and dismissed (boolean) are required',
        });
      }

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
      const { tier, year, month, quarter, periodKey, force } = req.body || {};

      // Tier is required — the retired DAILY fallback was removed in v1.
      if (!tier) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: `tier is required. Must be one of: ${VALID_TIERS.join(', ')}`,
        });
      }
      if (!VALID_TIERS.includes(tier)) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: `Invalid tier. Must be one of: ${VALID_TIERS.join(', ')}`,
        });
      }

      // Default the period to "current" when the client doesn't specify one.
      // PORTFOLIO is period-agnostic. For MONTHLY/QUARTERLY/ANNUAL the backend
      // requires year (and month/quarter), so derive them from today's date.
      const now = new Date();
      let resolvedYear = year ? parseInt(year, 10) : undefined;
      let resolvedMonth = month ? parseInt(month, 10) : undefined;
      let resolvedQuarter = quarter ? parseInt(quarter, 10) : undefined;
      if (tier === 'MONTHLY') {
        if (!resolvedYear) resolvedYear = now.getUTCFullYear();
        if (!resolvedMonth) resolvedMonth = now.getUTCMonth() + 1;
      } else if (tier === 'QUARTERLY') {
        if (!resolvedYear) resolvedYear = now.getUTCFullYear();
        if (!resolvedQuarter) resolvedQuarter = Math.floor(now.getUTCMonth() / 3) + 1;
      } else if (tier === 'ANNUAL') {
        if (!resolvedYear) resolvedYear = now.getUTCFullYear();
      }

      let backendResponse;
      try {
        backendResponse = await fetch(`${BACKEND_URL}/api/insights/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': BACKEND_API_KEY,
          },
          body: JSON.stringify({
            tenantId: user.tenantId,
            tier,
            year: resolvedYear,
            month: resolvedMonth,
            quarter: resolvedQuarter,
            periodKey,
            force: force === true || force === 'true',
          }),
        });
      } catch (err) {
        Sentry.captureException(err);
        return res.status(StatusCodes.BAD_GATEWAY).json({
          error: 'Failed to reach insight generation service',
        });
      }

      if (!backendResponse.ok) {
        const body = await backendResponse.text().catch(() => '');
        Sentry.captureMessage('Insight dispatch rejected by backend', {
          level: 'error',
          extra: { status: backendResponse.status, body, tier, tenantId: user.tenantId },
        });
        return res.status(backendResponse.status).json({
          error: 'Insight generation could not be enqueued',
          details: body || undefined,
        });
      }

      return res.status(StatusCodes.ACCEPTED).json({
        message: 'Insight generation started',
        tier,
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
