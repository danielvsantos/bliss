/**
 * GET    /api/enablebanking/connections/:id  — connection + accounts for the mapping step
 * DELETE /api/enablebanking/connections/:id  — disconnect (admin or the authorising user)
 *
 * GET returns each bank account with `suggestedAccountId` (R5: IBAN last 4 +
 * currency), `conflict` (R6: the same bank account is mapped through another
 * active connection) and the tenant's Bliss accounts with the provider that
 * currently syncs each one (R5a). Account numbers are never returned — last 4 only.
 *
 * DELETE calls DELETE /sessions/{id} (best effort) and sets the connection to
 * REVOKED; Bliss accounts, their mapping and all ingested data are kept, like
 * a Plaid disconnect, so a reconnect re-attaches without a mapping step.
 *
 * Per-tenant credentials (#148): GET works without them and reports
 * `paused: true`; DELETE needs them (404 NOT_ENABLED) to end the session.
 */

import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../../prisma/prisma';
import { withAuth } from '../../../../utils/withAuth.js';
import {
  PROVIDER,
  applyRateLimit,
  getTenantEnableBanking,
  lastFour,
  notEnabled,
  suggestAccountId,
} from '../../../../utils/enableBanking.js';
import { syncCutoffDate, syncDateFrom, isoDate } from '@bliss/shared/enablebanking';

export default withAuth(async function handler(req, res) {
  await applyRateLimit(req, res);

  if (!['GET', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', ['GET', 'DELETE']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }
  if (req.user.role === 'viewer') {
    return res.status(StatusCodes.FORBIDDEN).json({ error: 'Viewers cannot manage bank connections' });
  }

  try {
    const item = await prisma.plaidItem.findFirst({
      where: { id: String(req.query.id), tenantId: req.user.tenantId, provider: PROVIDER },
      include: {
        tenant: { select: { plaidHistoryDays: true } },
        enableBankingAccounts: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!item) return res.status(StatusCodes.NOT_FOUND).json({ error: 'Connection not found' });

    const eb = await getTenantEnableBanking(req.user.tenantId);
    if (req.method === 'DELETE') {
      if (!eb) return notEnabled(res);
      return handleDelete(req, res, item, eb.client);
    }
    return handleGet(req, res, item, { paused: !eb && item.status !== 'REVOKED' });
  } catch (error) {
    Sentry.captureException(error);
    console.error('[enablebanking/connections] failed:', error.message);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Server Error' });
  }
});

async function handleGet(req, res, item, { paused }) {
  const tenantId = req.user.tenantId;
  const [blissAccounts, otherMappings] = await Promise.all([
    prisma.account.findMany({
      where: { tenantId },
      select: {
        id: true, name: true, accountNumber: true, mask: true, currencyCode: true,
        plaidItemId: true, plaidItem: { select: { provider: true, status: true } },
      },
      orderBy: { name: 'asc' },
    }),
    prisma.enableBankingAccount.findMany({
      where: {
        tenantId,
        identificationHash: { in: item.enableBankingAccounts.map((a) => a.identificationHash) },
        plaidItemId: { not: item.id },
        accountId: { not: null },
        plaidItem: { status: { not: 'REVOKED' } },
      },
      select: { identificationHash: true },
    }),
  ]);
  const conflicted = new Set(otherMappings.map((m) => m.identificationHash));
  const historyDays = item.tenant?.plaidHistoryDays ?? 1;

  return res.status(StatusCodes.OK).json({
    connection: {
      id: item.id,
      institutionName: item.institutionName,
      aspspCountry: item.aspspCountry,
      status: item.status,
      consentExpiration: item.consentExpiration,
      lastSync: item.lastSync,
      createdAt: item.createdAt,
      authorizedByMe: item.userId === req.user.id,
      paused,
    },
    startDate: isoDate(item.lastSync
      ? syncDateFrom({ createdAt: item.createdAt, historyDays, lastSync: item.lastSync })
      : syncCutoffDate(item.createdAt, historyDays)),
    accounts: item.enableBankingAccounts.map((a) => ({
      id: a.id,
      name: a.name,
      ibanLast4: a.ibanLast4,
      currency: a.currency,
      accountId: a.accountId,
      suggestedAccountId: a.accountId ?? suggestAccountId(a, blissAccounts),
      conflict: conflicted.has(a.identificationHash),
      lastBalance: a.lastBalance === null ? null : String(a.lastBalance),
      lastBalanceCurrency: a.lastBalanceCurrency,
      lastBalanceAt: a.lastBalanceAt,
    })),
    blissAccounts: blissAccounts.map((b) => ({
      id: b.id,
      name: b.name,
      currencyCode: b.currencyCode,
      last4: lastFour(b.accountNumber) || lastFour(b.mask),
      linkedProvider: b.plaidItemId && b.plaidItemId !== item.id ? (b.plaidItem?.provider || 'PLAID') : null,
      linkedToThisConnection: b.plaidItemId === item.id,
    })),
  });
}

async function handleDelete(req, res, item, client) {
  if (req.user.role !== 'admin' && item.userId !== req.user.id) {
    return res.status(StatusCodes.FORBIDDEN).json({ error: 'Only an admin or the authorising user can disconnect' });
  }
  if (item.status === 'REVOKED') {
    return res.status(StatusCodes.CONFLICT).json({ error: 'Connection already disconnected' });
  }
  try {
    await client.deleteSession(item.accessToken);
  } catch (err) {
    // Best effort: an already-expired or unknown session must not block the disconnect.
    if (err?.status !== 404) console.warn('[enablebanking/disconnect] DELETE /sessions failed:', err.message);
  }
  await prisma.plaidItem.update({ where: { id: item.id }, data: { status: 'REVOKED', errorCode: null } });
  return res.status(StatusCodes.NO_CONTENT).end();
}
