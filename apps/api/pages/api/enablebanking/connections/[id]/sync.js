/**
 * POST /api/enablebanking/connections/:id/sync — "Sync now" (#132, R12)
 *
 * Read-only budget check, then 202 + ENABLE_BANKING_SYNC. Refused with
 * 429 SYNC_BUDGET_EXHAUSTED { resetsAt } when every mapped account has spent
 * its daily unattended-access budget. The worker's counter stays the authority.
 */

import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../../../prisma/prisma';
import { withAuth } from '../../../../../utils/withAuth.js';
import { produceEvent } from '../../../../../utils/produceEvent.js';
import {
  PROVIDER,
  applyRateLimit,
  budgetStatus,
  getTenantEnableBanking,
  notEnabled,
} from '../../../../../utils/enableBanking.js';

export default withAuth(async function handler(req, res) {
  await applyRateLimit(req, res);

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  try {
    if (!(await getTenantEnableBanking(req.user.tenantId))) return notEnabled(res);

    const item = await prisma.plaidItem.findFirst({
      where: { id: String(req.query.id), tenantId: req.user.tenantId, provider: PROVIDER },
      select: {
        id: true,
        status: true,
        enableBankingAccounts: {
          where: { accountId: { not: null }, account: { plaidItemId: String(req.query.id) } },
          select: { id: true },
        },
      },
    });
    if (!item) return res.status(StatusCodes.NOT_FOUND).json({ error: 'Connection not found' });
    if (item.status !== 'ACTIVE') {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: `Cannot sync — connection status is ${item.status}. Reconnect first.`,
        code: 'CONNECTION_NOT_ACTIVE',
      });
    }
    if (item.enableBankingAccounts.length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: 'No accounts are mapped on this connection', code: 'NO_MAPPED_ACCOUNTS' });
    }

    const budget = await budgetStatus(item.enableBankingAccounts.map((a) => a.id));
    if (budget.exhausted) {
      return res.status(StatusCodes.TOO_MANY_REQUESTS).json({
        error: 'The bank allows only a few automatic refreshes per day. Try again after the reset.',
        code: 'SYNC_BUDGET_EXHAUSTED',
        resetsAt: budget.resetsAt,
      });
    }

    await produceEvent({ type: 'ENABLE_BANKING_SYNC', tenantId: req.user.tenantId, plaidItemId: item.id, source: 'MANUAL_RESYNC' });
    return res.status(StatusCodes.ACCEPTED).json({ message: 'Sync triggered' });
  } catch (error) {
    Sentry.captureException(error);
    console.error('[enablebanking/sync] failed:', error.message);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Failed to trigger sync' });
  }
});
