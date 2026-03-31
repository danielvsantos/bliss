import { StatusCodes } from 'http-status-codes';
import prisma from '../../../prisma/prisma.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { cors } from '../../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { withAuth } from '../../../utils/withAuth.js';

/**
 * GET /api/notifications/summary
 * Aggregates 4 signals from existing tables. Pure read — no notification table.
 *
 * PUT /api/notifications/summary
 * Marks notifications as seen (updates User.lastNotificationSeenAt).
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
      const lastSeenAt = user.lastNotificationSeenAt || new Date(0);

      // Run 4 parallel queries against existing tables
      const [
        plaidClassifiedCount,
        pendingImportCount,
        plaidItemsNeedingAction,
        newInsightCount,
        tenant,
        accountCount,
        hasTransaction,
      ] = await Promise.all([
        // 1. Plaid transactions awaiting review
        prisma.plaidTransaction.count({
          where: {
            plaidItem: { tenantId: user.tenantId },
            promotionStatus: 'CLASSIFIED',
          },
        }),
        // 2. Staged import rows pending
        prisma.stagedImportRow.count({
          where: {
            stagedImport: { tenantId: user.tenantId, status: 'READY' },
            status: 'PENDING',
          },
        }),
        // 3. Plaid items needing re-auth or erroring
        prisma.plaidItem.findMany({
          where: {
            tenantId: user.tenantId,
            status: { in: ['LOGIN_REQUIRED', 'ERROR'] },
          },
          select: { id: true, institutionName: true, status: true },
        }),
        // 4. New insights since last seen
        prisma.insight.count({
          where: {
            tenantId: user.tenantId,
            dismissed: false,
            createdAt: { gt: lastSeenAt },
          },
        }),
        // 5. Onboarding progress (for checklist signal)
        prisma.tenant.findUnique({
          where: { id: user.tenantId },
          select: { onboardingProgress: true, onboardingCompletedAt: true },
        }),
        // 6. Account count for onboarding validation
        prisma.account.count({ where: { tenantId: user.tenantId } }),
        // 7. Transaction existence for onboarding validation
        prisma.transaction.findFirst({
          where: { tenantId: user.tenantId },
          select: { id: true },
        }),
      ]);

      const totalReviewCount = plaidClassifiedCount + pendingImportCount;
      const signals = [];

      // Signal 1: Pending review (always "new" since it's actionable)
      if (totalReviewCount > 0) {
        signals.push({
          type: 'PENDING_REVIEW',
          count: totalReviewCount,
          label: `${totalReviewCount} transaction${totalReviewCount !== 1 ? 's' : ''} awaiting review`,
          href: '/agents/review',
          severity: 'info',
          isNew: true,
        });
      }

      // Signal 2: Plaid action required
      for (const item of plaidItemsNeedingAction) {
        signals.push({
          type: 'PLAID_ACTION_REQUIRED',
          count: 1,
          label: `${item.institutionName || 'Bank'} requires ${item.status === 'LOGIN_REQUIRED' ? 're-authentication' : 'attention'}`,
          href: '/accounts',
          severity: 'warning',
          isNew: true,
        });
      }

      // Signal 3: Onboarding incomplete (never "new" — persistent state)
      if (tenant && !tenant.onboardingCompletedAt) {
        const checklist = tenant.onboardingProgress?.checklist;
        if (checklist) {
          // Apply same server-side validation as GET /api/onboarding/progress
          if (accountCount > 0) checklist.connectBank = { ...checklist.connectBank, done: true };
          if (hasTransaction) checklist.reviewTransactions = { ...checklist.reviewTransactions, done: true };
          delete checklist.setPortfolioCurrency;

          const incomplete = Object.values(checklist).filter((v) => !v.done && !v.skipped).length;
          if (incomplete > 0) {
            signals.push({
              type: 'ONBOARDING_INCOMPLETE',
              count: incomplete,
              label: `${incomplete} setup step${incomplete !== 1 ? 's' : ''} remaining`,
              href: '/',
              severity: 'info',
              isNew: false,
            });
          }
        }
      }

      // Signal 4: New insights
      if (newInsightCount > 0) {
        signals.push({
          type: 'NEW_INSIGHTS',
          count: newInsightCount,
          label: `${newInsightCount} new insight${newInsightCount !== 1 ? 's' : ''} available`,
          href: '/agents/insight',
          severity: 'positive',
          isNew: true,
        });
      }

      const totalUnseen = signals.filter((s) => s.isNew).reduce((sum, s) => sum + s.count, 0);

      return res.status(StatusCodes.OK).json({
        totalUnseen,
        lastSeenAt: user.lastNotificationSeenAt || null,
        signals,
      });
    }

    if (req.method === 'PUT') {
      await prisma.user.update({
        where: { id: user.id },
        data: { lastNotificationSeenAt: new Date() },
      });

      return res.status(StatusCodes.OK).json({ success: true });
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
