/**
 * GET /api/enablebanking/callback?code=…&state=…  (or ?error=…&state=…)
 *
 * The redirect URL registered on the Enable Banking app (#132, R3/R4). A
 * top-level navigation from the bank, so the signed single-use `state` is the
 * authority (D6); a session cookie, when it arrives, must belong to the same
 * user. Exchanges `code` through POST /sessions and, in one transaction,
 * creates (or, on reconnect, re-keys) the PlaidItem and upserts one
 * EnableBankingAccount per returned account — POST /sessions returns account
 * details only once. Always answers with a redirect into the web app:
 *
 *   /accounts?eb=map&connection=<id>         new accounts to map
 *   /accounts?eb=reconnected&connection=<id> reconnect, every account re-linked
 *   /accounts?eb_error=invalid_state|denied|exchange_failed
 */

import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../prisma/prisma';
import { withAuth } from '../../../utils/withAuth.js';
import { produceEvent } from '../../../utils/produceEvent.js';
import {
  PROVIDER,
  applyRateLimit,
  consumeState,
  getEnableBankingClient,
  getFrontendUrl,
  isEnableBankingEnabled,
  lastFour,
} from '../../../utils/enableBanking.js';
import { ebAccountKey, EB_ITEM_PREFIX } from '@bliss/shared/enablebanking';

function redirect(res, query) {
  res.setHeader('Cache-Control', 'no-store');
  return res.redirect(302, `${getFrontendUrl()}/accounts?${new URLSearchParams(query).toString()}`);
}

function accountName(acc) {
  return acc.name || acc.product || acc.details || null;
}

export default withAuth(async function handler(req, res) {
  await applyRateLimit(req, res);

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).end();
  }
  if (!isEnableBankingEnabled()) return redirect(res, { eb_error: 'not_enabled' });

  const { code, state, error } = req.query;
  const parsed = await consumeState(Array.isArray(state) ? state[0] : state);
  if (!parsed) return redirect(res, { eb_error: 'invalid_state' });
  // A signed-in browser must be the user who started the flow.
  if (req.user && (req.user.id !== parsed.userId || req.user.tenantId !== parsed.tenantId)) {
    return redirect(res, { eb_error: 'invalid_state' });
  }

  const user = await prisma.user.findFirst({
    where: { id: parsed.userId, tenantId: parsed.tenantId },
    select: { id: true, tenantId: true },
  });
  if (!user) return redirect(res, { eb_error: 'invalid_state' });

  if (error || !code) return redirect(res, { eb_error: 'denied' });

  let reconnectItem = null;
  if (parsed.reconnectItemId) {
    reconnectItem = await prisma.plaidItem.findFirst({
      where: { id: parsed.reconnectItemId, tenantId: user.tenantId, provider: PROVIDER, userId: user.id },
      select: { id: true },
    });
    if (!reconnectItem) return redirect(res, { eb_error: 'invalid_state' });
  }

  let session;
  try {
    session = await getEnableBankingClient().createSession(String(code));
  } catch (err) {
    Sentry.captureException(err);
    console.error('[enablebanking/callback] session exchange failed:', err.message);
    return redirect(res, { eb_error: 'exchange_failed' });
  }

  const accounts = (Array.isArray(session?.accounts) ? session.accounts : [])
    .filter((a) => a?.uid && a?.identification_hash);
  if (!session?.session_id) return redirect(res, { eb_error: 'exchange_failed' });

  try {
    const { itemId, needsMapping } = await prisma.$transaction(async (tx) => {
      const consentExpiration = session.access?.valid_until ? new Date(session.access.valid_until) : null;
      let item;
      if (reconnectItem) {
        item = await tx.plaidItem.update({
          where: { id: reconnectItem.id },
          data: {
            accessToken: session.session_id,
            consentExpiration,
            status: 'ACTIVE',
            errorCode: null,
          },
        });
      } else {
        item = await tx.plaidItem.create({
          data: {
            tenantId: user.tenantId,
            userId: user.id,
            itemId: `${EB_ITEM_PREFIX}${randomUUID()}`,
            accessToken: session.session_id,
            provider: PROVIDER,
            institutionName: session.aspsp?.name || null,
            aspspCountry: session.aspsp?.country || null,
            consentExpiration,
            environment: 'production',
            // ACTIVE once at least one account is mapped (map route).
            status: 'PENDING_SELECTION',
          },
        });
      }

      let unmapped = 0;
      for (const acc of accounts) {
        const iban = acc.account_id?.iban || null;
        const row = await tx.enableBankingAccount.upsert({
          where: { plaidItemId_identificationHash: { plaidItemId: item.id, identificationHash: acc.identification_hash } },
          update: {
            uid: acc.uid,
            iban,
            ibanLast4: lastFour(iban),
            currency: acc.currency || null,
            name: accountName(acc),
          },
          create: {
            tenantId: user.tenantId,
            plaidItemId: item.id,
            authorizedByUserId: user.id,
            uid: acc.uid,
            identificationHash: acc.identification_hash,
            iban,
            ibanLast4: lastFour(iban),
            currency: acc.currency || null,
            name: accountName(acc),
          },
        });
        if (!row.accountId) {
          unmapped++;
          continue;
        }
        // Reconnect: re-attach the same Bliss account (R7), unless it has since
        // been linked to another connection.
        await tx.account.updateMany({
          where: {
            id: row.accountId,
            tenantId: user.tenantId,
            OR: [{ plaidItemId: null }, { plaidItemId: item.id }],
          },
          data: { plaidAccountId: ebAccountKey(acc.identification_hash), plaidItemId: item.id },
        });
      }
      return { itemId: item.id, needsMapping: unmapped > 0 || accounts.length === 0 };
    });

    if (!needsMapping) {
      await produceEvent({ type: 'ENABLE_BANKING_SYNC', tenantId: user.tenantId, plaidItemId: itemId, source: 'RECONNECT_SYNC' });
      return redirect(res, { eb: 'reconnected', connection: itemId });
    }
    return redirect(res, { eb: 'map', connection: itemId });
  } catch (err) {
    Sentry.captureException(err);
    console.error('[enablebanking/callback] persisting the session failed:', err.message);
    return redirect(res, { eb_error: 'exchange_failed' });
  }
}, { optional: true });
