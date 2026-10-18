import { StatusCodes } from 'http-status-codes';
import prisma from '../../../prisma/prisma.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { cors } from '../../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { withAuth } from '../../../utils/withAuth.js';
import { readActivity, countFailuresSince } from '../../../utils/activityStore.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Enable Banking consent reminders (#132): 14 days ahead, then urgent at 3 days.
const CONSENT_WARNING_DAYS = 14;
const CONSENT_URGENT_DAYS = 3;

/**
 * GET /api/notifications/summary
 * Aggregates signals from existing tables, plus PROCESSING_FAILED from the
 * processing-status hash in Redis (#100). Pure read — no notification table.
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
        plaidFailedCount,
        activity,
        expiringConsents,
        invalidEnableBankingCredential,
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
        // 3. Bank connections needing re-auth or erroring. Enable Banking consents
        //    are personal (#132): only the user who authorised one is prompted.
        prisma.plaidItem.findMany({
          where: {
            tenantId: user.tenantId,
            status: { in: ['LOGIN_REQUIRED', 'ERROR'] },
            OR: [{ provider: { not: 'ENABLE_BANKING' } }, { userId: user.id }],
          },
          select: { id: true, institutionName: true, status: true, provider: true },
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
        // 8. Plaid transactions that failed classification (need retry or manual categorize)
        prisma.plaidTransaction.count({
          where: {
            plaidItem: { tenantId: user.tenantId },
            promotionStatus: 'FAILED',
          },
        }),
        // 9. Background jobs that failed on their final attempt (Redis, fail-soft; #100)
        readActivity(user.tenantId),
        // 10. This user's Enable Banking consents expiring within 14 days (#132)
        prisma.plaidItem.findMany({
          where: {
            tenantId: user.tenantId,
            userId: user.id,
            provider: 'ENABLE_BANKING',
            status: 'ACTIVE',
            consentExpiration: { gt: new Date(), lte: new Date(Date.now() + CONSENT_WARNING_DAYS * DAY_MS) },
          },
          select: { id: true, institutionName: true, consentExpiration: true },
        }),
        // 11. The tenant's Enable Banking credentials rejected by Enable Banking (#148, admins only)
        user.role === 'admin'
          ? prisma.enableBankingCredential.findFirst({
            where: { tenantId: user.tenantId, status: 'INVALID' },
            select: { invalidatedAt: true },
          })
          : null,
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
          label: item.provider === 'ENABLE_BANKING'
            ? `${item.institutionName || 'Bank'} needs to be re-connected`
            : `${item.institutionName || 'Bank'} requires ${item.status === 'LOGIN_REQUIRED' ? 're-authentication' : 'attention'}`,
          href: '/accounts',
          severity: 'warning',
          isNew: true,
        });
      }

      // Signal 2b: Enable Banking consent expiring (#132). Derived on read, no
      // table: "new" when the 14-day or 3-day threshold was crossed after the
      // user last opened the notification center. Expiry itself surfaces as
      // PLAID_ACTION_REQUIRED once the sync marks the connection LOGIN_REQUIRED.
      for (const item of expiringConsents) {
        const expiresAt = new Date(item.consentExpiration);
        const msLeft = expiresAt.getTime() - Date.now();
        const urgent = msLeft <= CONSENT_URGENT_DAYS * DAY_MS;
        const thresholdCrossedAt = new Date(expiresAt.getTime() - (urgent ? CONSENT_URGENT_DAYS : CONSENT_WARNING_DAYS) * DAY_MS);
        const daysLeft = Math.max(1, Math.ceil(msLeft / DAY_MS));
        signals.push({
          type: 'BANK_CONSENT_EXPIRING',
          count: 1,
          label: `${item.institutionName || 'Bank'} access expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''} — reconnect to keep syncing`,
          href: '/accounts',
          severity: urgent ? 'warning' : 'info',
          isNew: thresholdCrossedAt > lastSeenAt,
          expiresAt: expiresAt.toISOString(),
        });
      }

      // Signal 2c: the tenant's Enable Banking app credentials need attention
      // (#148). Admin only, separate from the per-connection reconnect signal.
      if (invalidEnableBankingCredential) {
        const invalidatedAt = invalidEnableBankingCredential.invalidatedAt;
        signals.push({
          type: 'ENABLE_BANKING_CREDENTIALS_INVALID',
          count: 1,
          label: 'Enable Banking credentials need attention',
          href: '/settings?tab=bank-sync',
          severity: 'warning',
          isNew: !invalidatedAt || new Date(invalidatedAt) > lastSeenAt,
        });
      }

      // Signal 3: Plaid transactions that failed classification (kept distinct from
      // PENDING_REVIEW so a data-loss risk isn't silently folded into a routine count)
      if (plaidFailedCount > 0) {
        signals.push({
          type: 'PLAID_CLASSIFICATION_FAILED',
          count: plaidFailedCount,
          label: `${plaidFailedCount} transaction${plaidFailedCount !== 1 ? 's' : ''} failed classification`,
          href: '/agents/review?source=plaid',
          severity: 'warning',
          isNew: true,
        });
      }

      // Signal: background processing failed (final attempt) since last seen (#100).
      // Admins get a link to Settings → Processing; other roles see the label only.
      const processingFailedCount = countFailuresSince(activity, user.lastNotificationSeenAt);
      if (processingFailedCount > 0) {
        signals.push({
          type: 'PROCESSING_FAILED',
          count: processingFailedCount,
          label: `${processingFailedCount} background update${processingFailedCount !== 1 ? 's' : ''} failed`,
          href: user.role === 'admin' ? '/settings?tab=processing' : null,
          severity: 'warning',
          isNew: true,
        });
      }

      // Signal 4: Onboarding incomplete (never "new" — persistent state)
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

      // Signal 5: New insights
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
