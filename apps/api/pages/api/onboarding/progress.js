import { StatusCodes } from 'http-status-codes';
import prisma from '../../../prisma/prisma.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { cors } from '../../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { withAuth } from '../../../utils/withAuth.js';

/**
 * GET /api/onboarding/progress
 * Returns the current tenant's onboarding progress and completion status.
 *
 * PUT /api/onboarding/progress
 * Updates onboarding progress. Body: { step: string, data?: any }
 * Marks a checklist item or setup flow step as done.
 *
 * Valid step values:
 *   Checklist:  connectBank, reviewTransactions, setPortfolioCurrency, exploreExpenses, checkPnL (displayed as "Check Financial Summary")
 *   Setup flow: step1_profile, step2_connect
 *   Special:    setupComplete (sets onboardingCompletedAt), dismissChecklist
 */

const DEFAULT_CHECKLIST = {
  connectBank: { done: false, skipped: false },
  reviewTransactions: { done: false },
  exploreExpenses: { done: false },
  checkPnL: { done: false },
};

const CHECKLIST_KEYS = Object.keys(DEFAULT_CHECKLIST);

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
      const [tenant, accountCount, hasTransaction] = await Promise.all([
        prisma.tenant.findUnique({
          where: { id: user.tenantId },
          select: { onboardingProgress: true, onboardingCompletedAt: true },
        }),
        prisma.account.count({ where: { tenantId: user.tenantId } }),
        prisma.transaction.findFirst({
          where: { tenantId: user.tenantId },
          select: { id: true },
        }),
      ]);
      if (!tenant) {
        return res.status(StatusCodes.NOT_FOUND).json({ error: 'Tenant not found' });
      }

      const progress = tenant.onboardingProgress || { checklist: { ...DEFAULT_CHECKLIST }, setupFlow: {} };
      if (!progress.checklist) progress.checklist = { ...DEFAULT_CHECKLIST };

      // Server-side validation: auto-correct data-backed steps
      if (accountCount > 0 && !progress.checklist.connectBank?.done) {
        progress.checklist.connectBank = { ...progress.checklist.connectBank, done: true };
      }
      if (hasTransaction && !progress.checklist.reviewTransactions?.done) {
        progress.checklist.reviewTransactions = { ...progress.checklist.reviewTransactions, done: true };
      }

      // Strip deprecated step from legacy data
      delete progress.checklist.setPortfolioCurrency;

      return res.status(StatusCodes.OK).json({
        onboardingProgress: progress,
        onboardingCompletedAt: tenant.onboardingCompletedAt,
      });
    }

    if (req.method === 'PUT') {
      const { step, data } = req.body;

      if (!step || typeof step !== 'string') {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'step is required and must be a string',
        });
      }

      // Fetch current progress
      const tenant = await prisma.tenant.findUnique({
        where: { id: user.tenantId },
        select: { onboardingProgress: true, onboardingCompletedAt: true },
      });
      if (!tenant) {
        return res.status(StatusCodes.NOT_FOUND).json({ error: 'Tenant not found' });
      }

      const progress = tenant.onboardingProgress || { checklist: { ...DEFAULT_CHECKLIST }, setupFlow: {} };
      if (!progress.checklist) progress.checklist = { ...DEFAULT_CHECKLIST };
      if (!progress.setupFlow) progress.setupFlow = {};

      const updateData = {};

      // Handle special steps
      if (step === 'setupComplete') {
        updateData.onboardingCompletedAt = new Date();
      } else if (step === 'dismissChecklist') {
        progress.checklistDismissed = true;
      } else if (step === 'setPortfolioCurrency') {
        // Deprecated step — ignore silently for backward compatibility
        return res.status(StatusCodes.OK).json({
          onboardingProgress: progress,
          onboardingCompletedAt: tenant.onboardingCompletedAt,
        });
      } else if (CHECKLIST_KEYS.includes(step)) {
        // Mark checklist item
        progress.checklist[step] = {
          ...progress.checklist[step],
          done: true,
          ...(data || {}),
        };
      } else if (step.startsWith('step')) {
        // Setup flow step (step1_profile, step2_connect)
        progress.setupFlow[step] = {
          completedAt: new Date().toISOString(),
          ...(data || {}),
        };
      } else {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: `Unknown step: ${step}. Valid steps: ${CHECKLIST_KEYS.join(', ')}, step1_profile, step2_connect, setupComplete, dismissChecklist`,
        });
      }

      updateData.onboardingProgress = progress;

      const updated = await prisma.tenant.update({
        where: { id: user.tenantId },
        data: updateData,
        select: { onboardingProgress: true, onboardingCompletedAt: true },
      });

      return res.status(StatusCodes.OK).json({
        onboardingProgress: updated.onboardingProgress,
        onboardingCompletedAt: updated.onboardingCompletedAt,
      });
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
