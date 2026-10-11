/**
 * POST /api/enablebanking/connections/:id/map (#132, R5 / R5a / R6)
 *
 * Body: {
 *   mappings: [{ ebAccountId, accountId? , create?: { name, bankId, countryId, currencyCode }, skip?: true }],
 *   confirmProviderSwitch?: boolean
 * }
 *
 * - `accountId` links an existing Bliss account; `create` creates one (never
 *   implicitly); `skip` leaves the bank account unsynced.
 * - 409 ACCOUNT_ALREADY_CONNECTED: the bank account is mapped through another
 *   active connection (R6; also enforced by a partial unique index).
 * - 409 PROVIDER_SWITCH_REQUIRED { accounts }: a target is synced by another
 *   connection (usually Plaid) and `confirmProviderSwitch` is not set (R5a).
 *   On confirm, the SAME Account rows are re-pointed (id, history and
 *   transactions unchanged) and a Plaid item left with no linked account is
 *   set to REVOKED.
 * - On success the connection becomes ACTIVE and its first sync is enqueued.
 */

import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../../../prisma/prisma';
import { withAuth } from '../../../../../utils/withAuth.js';
import { produceEvent } from '../../../../../utils/produceEvent.js';
import {
  PROVIDER,
  applyRateLimit,
  isEnableBankingEnabled,
} from '../../../../../utils/enableBanking.js';
import { ebAccountKey } from '@bliss/shared/enablebanking';

class MapError extends Error {
  constructor(status, body) {
    super(body.error);
    this.status = status;
    this.body = body;
  }
}

function validateMappings(body) {
  const mappings = body?.mappings;
  if (!Array.isArray(mappings) || mappings.length === 0 || mappings.length > 50) {
    throw new MapError(StatusCodes.BAD_REQUEST, { error: 'mappings must be a non-empty array' });
  }
  for (const m of mappings) {
    if (!m || typeof m.ebAccountId !== 'string') {
      throw new MapError(StatusCodes.BAD_REQUEST, { error: 'Each mapping needs an ebAccountId' });
    }
    const modes = [m.accountId !== undefined && m.accountId !== null, Boolean(m.create), m.skip === true].filter(Boolean).length;
    if (modes !== 1) {
      throw new MapError(StatusCodes.BAD_REQUEST, { error: 'Each mapping needs exactly one of accountId, create or skip' });
    }
    if (m.accountId !== undefined && m.accountId !== null && !Number.isInteger(Number(m.accountId))) {
      throw new MapError(StatusCodes.BAD_REQUEST, { error: 'accountId must be an integer' });
    }
    if (m.create) {
      const { name, bankId, countryId, currencyCode } = m.create;
      if (typeof name !== 'string' || !name.trim() || name.length > 100 || !Number.isInteger(Number(bankId))
        || typeof countryId !== 'string' || typeof currencyCode !== 'string') {
        throw new MapError(StatusCodes.BAD_REQUEST, { error: 'create needs name, bankId, countryId and currencyCode' });
      }
    }
  }
  const ids = mappings.map((m) => m.ebAccountId);
  if (new Set(ids).size !== ids.length) {
    throw new MapError(StatusCodes.BAD_REQUEST, { error: 'Each bank account can appear only once' });
  }
  const targets = mappings.filter((m) => m.accountId != null).map((m) => Number(m.accountId));
  if (new Set(targets).size !== targets.length) {
    throw new MapError(StatusCodes.BAD_REQUEST, { error: 'Two bank accounts cannot feed the same Bliss account', code: 'DUPLICATE_TARGET' });
  }
  return mappings;
}

export default withAuth(async function handler(req, res) {
  await applyRateLimit(req, res);

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }
  if (!isEnableBankingEnabled()) {
    return res.status(StatusCodes.NOT_FOUND).json({ error: 'Enable Banking is not configured', code: 'NOT_ENABLED' });
  }

  const tenantId = req.user.tenantId;
  const itemId = String(req.query.id);

  try {
    const mappings = validateMappings(req.body);
    const confirm = req.body?.confirmProviderSwitch === true;

    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.plaidItem.findFirst({
        where: { id: itemId, tenantId, provider: PROVIDER },
      });
      if (!item) throw new MapError(StatusCodes.NOT_FOUND, { error: 'Connection not found' });
      // Top-level read: the encryption extension decrypts `iban` only on the queried model.
      const ebAccounts = await tx.enableBankingAccount.findMany({ where: { plaidItemId: item.id, tenantId } });
      if (item.status === 'REVOKED') {
        throw new MapError(StatusCodes.CONFLICT, { error: 'Connection is disconnected. Reconnect first.', code: 'CONNECTION_REVOKED' });
      }
      const ebById = new Map(ebAccounts.map((a) => [a.id, a]));
      for (const m of mappings) {
        if (!ebById.has(m.ebAccountId)) {
          throw new MapError(StatusCodes.BAD_REQUEST, { error: 'Unknown bank account for this connection' });
        }
      }
      // A Bliss account already fed by another bank account of this connection
      // (one not re-mapped in this request) cannot take a second feed.
      const requested = new Set(mappings.map((m) => m.ebAccountId));
      for (const m of mappings) {
        if (m.accountId == null) continue;
        const holder = ebAccounts.find((a) => a.accountId === Number(m.accountId) && a.id !== m.ebAccountId && !requested.has(a.id));
        if (holder) {
          throw new MapError(StatusCodes.BAD_REQUEST, { error: 'Two bank accounts cannot feed the same Bliss account', code: 'DUPLICATE_TARGET' });
        }
      }

      // ── R6: the same bank account mapped through another connection ───────
      const linking = mappings.filter((m) => !m.skip);
      const hashes = linking.map((m) => ebById.get(m.ebAccountId).identificationHash);
      const elsewhere = hashes.length === 0 ? [] : await tx.enableBankingAccount.findMany({
        where: { tenantId, identificationHash: { in: hashes }, plaidItemId: { not: item.id }, accountId: { not: null } },
        include: { plaidItem: { select: { status: true } } },
      });
      const activeConflict = elsewhere.find((e) => e.plaidItem.status !== 'REVOKED');
      if (activeConflict) {
        throw new MapError(StatusCodes.CONFLICT, {
          error: 'This bank account is already synced through another connection. Authorise a joint account under one holder only.',
          code: 'ACCOUNT_ALREADY_CONNECTED',
          ebAccountIds: linking
            .filter((m) => ebById.get(m.ebAccountId).identificationHash === activeConflict.identificationHash)
            .map((m) => m.ebAccountId),
        });
      }

      // ── R5a: targets synced by another connection need a confirmed switch ──
      const targetIds = linking.filter((m) => m.accountId != null).map((m) => Number(m.accountId));
      const targets = targetIds.length === 0 ? [] : await tx.account.findMany({
        where: { id: { in: targetIds }, tenantId },
        select: {
          id: true, name: true, plaidItemId: true, plaidAccountId: true,
          plaidItem: { select: { id: true, provider: true, institutionName: true } },
        },
      });
      if (targets.length !== new Set(targetIds).size) {
        throw new MapError(StatusCodes.BAD_REQUEST, { error: 'Unknown Bliss account' });
      }
      const targetById = new Map(targets.map((t) => [t.id, t]));
      const switching = targets.filter((t) => t.plaidItemId && t.plaidItemId !== item.id);
      if (switching.length > 0 && !confirm) {
        throw new MapError(StatusCodes.CONFLICT, {
          error: 'Some accounts are synced by another connection. Confirm to switch them to Enable Banking.',
          code: 'PROVIDER_SWITCH_REQUIRED',
          accounts: switching.map((t) => ({
            id: t.id,
            name: t.name,
            provider: t.plaidItem?.provider || 'PLAID',
            institutionName: t.plaidItem?.institutionName || null,
          })),
        });
      }

      // Release mappings held by disconnected connections for these bank accounts.
      if (elsewhere.length > 0) {
        await tx.enableBankingAccount.updateMany({
          where: { id: { in: elsewhere.map((e) => e.id) } },
          data: { accountId: null },
        });
      }

      const counts = { mapped: 0, created: 0, skipped: 0, switched: switching.length };
      const previousItemIds = new Set(switching.map((t) => t.plaidItemId));

      for (const m of mappings) {
        const eb = ebById.get(m.ebAccountId);
        const key = ebAccountKey(eb.identificationHash);

        if (m.skip) {
          // Unlink a previous mapping of this bank account on this connection.
          if (eb.accountId) {
            await tx.account.updateMany({
              where: { id: eb.accountId, tenantId, plaidItemId: item.id },
              data: { plaidAccountId: null, plaidItemId: null },
            });
          }
          await tx.enableBankingAccount.update({ where: { id: eb.id }, data: { accountId: null } });
          counts.skipped++;
          continue;
        }

        let accountId;
        if (m.create) {
          const { name, bankId, countryId, currencyCode } = m.create;
          const [bank, country, currency] = await Promise.all([
            tx.bank.findUnique({ where: { id: Number(bankId) }, select: { id: true } }),
            tx.country.findUnique({ where: { id: countryId }, select: { id: true } }),
            tx.currency.findUnique({ where: { id: currencyCode }, select: { id: true } }),
          ]);
          if (!bank || !country || !currency) {
            throw new MapError(StatusCodes.BAD_REQUEST, { error: 'Unknown bank, country or currency' });
          }
          const created = await tx.account.create({
            data: {
              name: name.trim(),
              accountNumber: eb.iban || eb.ibanLast4 || 'XXXX',
              mask: eb.ibanLast4,
              bankId: bank.id,
              countryId: country.id,
              currencyCode: currency.id,
              tenantId,
              plaidAccountId: key,
              plaidItemId: item.id,
              type: 'depository',
            },
          });
          accountId = created.id;
          counts.created++;
        } else {
          accountId = Number(m.accountId);
          const target = targetById.get(accountId);
          // The same Account row is re-pointed: id, history and transactions stay.
          await tx.account.update({
            where: { id: target.id },
            data: { plaidAccountId: key, plaidItemId: item.id, mask: eb.ibanLast4 || undefined },
          });
          counts.mapped++;
        }

        // A bank account previously mapped to a different Bliss account on this connection.
        if (eb.accountId && eb.accountId !== accountId) {
          await tx.account.updateMany({
            where: { id: eb.accountId, tenantId, plaidItemId: item.id, plaidAccountId: key },
            data: { plaidAccountId: null, plaidItemId: null },
          });
        }
        await tx.enableBankingAccount.update({ where: { id: eb.id }, data: { accountId } });
      }

      // Old connections with no linked account left stop syncing (history kept).
      for (const prevId of previousItemIds) {
        const remaining = await tx.account.count({ where: { tenantId, plaidItemId: prevId } });
        if (remaining === 0) {
          await tx.plaidItem.updateMany({
            where: { id: prevId, tenantId, status: { not: 'REVOKED' } },
            data: { status: 'REVOKED' },
          });
        }
      }

      const anyMapped = await tx.enableBankingAccount.count({ where: { plaidItemId: item.id, accountId: { not: null } } });
      if (anyMapped > 0 && item.status === 'PENDING_SELECTION') {
        await tx.plaidItem.update({ where: { id: item.id }, data: { status: 'ACTIVE' } });
      }
      return { ...counts, active: anyMapped > 0 && ['ACTIVE', 'PENDING_SELECTION'].includes(item.status) };
    });

    if (result.active && result.mapped + result.created > 0) {
      await produceEvent({ type: 'ENABLE_BANKING_SYNC', tenantId, plaidItemId: itemId, source: 'INITIAL' });
    }
    return res.status(StatusCodes.OK).json(result);
  } catch (error) {
    if (error instanceof MapError) return res.status(error.status).json(error.body);
    if (error?.code === 'P2002') {
      // Lost a race against another mapping of the same bank account (partial unique index).
      return res.status(StatusCodes.CONFLICT).json({
        error: 'This bank account is already synced through another connection.',
        code: 'ACCOUNT_ALREADY_CONNECTED',
      });
    }
    Sentry.captureException(error);
    console.error('[enablebanking/map] failed:', error.message);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Failed to map accounts' });
  }
});
