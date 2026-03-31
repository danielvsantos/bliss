/**
 * DELETE /api/plaid/items/hard-delete?id=<plaidItemId>
 *          OR
 * DELETE /api/plaid/items/hard-delete?itemId=<plaidExternalItemId>
 *
 * Admin-only endpoint — NOT protected by user JWT.
 * Requires `X-Admin-Key: <ADMIN_API_KEY>` header.
 *
 * Permanently destroys a Plaid connection:
 *   1. Calls plaidClient.itemRemove() to revoke the access token at Plaid's side.
 *      Tolerates ITEM_NOT_FOUND (item already deleted on Plaid's side — safe to proceed).
 *   2. Nullifies Account.plaidAccountId + Account.plaidItemId for every local
 *      Account that was linked to this PlaidItem (accounts are preserved).
 *   3. Deletes the PlaidItem record.
 *      → PlaidTransaction and PlaidSyncLog cascade-delete automatically (onDelete: Cascade).
 *
 * Intentionally PRESERVES:
 *   - Account records (unlinking is sufficient — financial accounts remain intact)
 *   - Transaction records (real promoted financial data must never be deleted here)
 *
 * This endpoint is intentionally invisible to end-users and should only be
 * called by internal tooling / support workflows.
 */

import { StatusCodes } from 'http-status-codes';
import { plaidClient } from '../../../../services/plaid.service';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../../prisma/prisma';

// ── Admin key validation ───────────────────────────────────────────────────────

function isAdminAuthorized(req) {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    console.warn('[hard-delete] ADMIN_API_KEY env var is not set — rejecting all requests');
    return false;
  }
  const provided = req.headers['x-admin-key'];
  return provided === adminKey;
}

// ── Route handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(StatusCodes.OK).end();
  }

  if (req.method !== 'DELETE') {
    res.setHeader('Allow', ['DELETE']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  // ── Auth ────────────────────────────────────────────────────────────────────
  if (!isAdminAuthorized(req)) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' });
  }

  // ── Param resolution ────────────────────────────────────────────────────────
  // Accept either our internal cuid (?id=) or Plaid's item_id (?itemId=)
  const { id, itemId } = req.query;

  if (!id && !itemId) {
    return res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: 'Provide either id (internal cuid) or itemId (Plaid item_id) as a query param' });
  }

  try {
    // ── Fetch PlaidItem ──────────────────────────────────────────────────────
    const where = id ? { id } : { itemId };
    const plaidItem = await prisma.plaidItem.findUnique({
      where,
      select: {
        id: true,
        itemId: true,
        tenantId: true,
        institutionName: true,
        accessToken: true, // auto-decrypted by Prisma middleware
      },
    });

    if (!plaidItem) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: 'PlaidItem not found' });
    }

    console.log(
      `[hard-delete] Starting hard delete for PlaidItem ${plaidItem.id} (${plaidItem.institutionName ?? 'unknown'}) — tenant: ${plaidItem.tenantId}`
    );

    // ── Step 1: Revoke token at Plaid ────────────────────────────────────────
    let plaidRemoveResult = null;
    try {
      const response = await plaidClient.itemRemove({ access_token: plaidItem.accessToken });
      plaidRemoveResult = response.data;
      console.log(`[hard-delete] plaidClient.itemRemove succeeded for item ${plaidItem.id}`);
    } catch (plaidErr) {
      const errorCode = plaidErr.response?.data?.error_code;
      if (errorCode === 'ITEM_NOT_FOUND') {
        // Item already removed on Plaid's side (e.g. user revoked via bank portal).
        // Safe to continue — we still need to clean up our local records.
        console.warn(
          `[hard-delete] ITEM_NOT_FOUND from Plaid for item ${plaidItem.id} — proceeding with local cleanup`
        );
      } else {
        // Unexpected Plaid error — abort before touching local data.
        Sentry.captureException(plaidErr);
        console.error(`[hard-delete] Unexpected Plaid error for item ${plaidItem.id}:`, plaidErr.message);
        return res.status(StatusCodes.BAD_GATEWAY).json({
          error: 'Plaid API error during itemRemove',
          ...(process.env.NODE_ENV === 'development' && { details: plaidErr.message, errorCode }),
        });
      }
    }

    // ── Step 2: Count linked records (for the response summary) ─────────────
    const [linkedAccountCount, plaidTxCount, syncLogCount] = await Promise.all([
      prisma.account.count({ where: { plaidItemId: plaidItem.id } }),
      prisma.plaidTransaction.count({ where: { plaidItemId: plaidItem.id } }),
      prisma.plaidSyncLog.count({ where: { plaidItemId: plaidItem.id } }),
    ]);

    // ── Step 3: Cascade delete inside a Prisma transaction ───────────────────
    //
    //   Deletion order (respects FK constraints):
    //   a) Unlink Accounts — nullify plaidAccountId + plaidItemId (accounts preserved)
    //   b) Delete PlaidItem — PlaidTransaction + PlaidSyncLog auto-cascade
    //
    //   Transaction records are intentionally untouched (they represent committed
    //   financial data and must remain for reporting purposes).
    //
    await prisma.$transaction(async (tx) => {
      // a) Unlink all local accounts that were connected via this PlaidItem.
      //    We null out both fields:
      //      - plaidItemId  — our FK to PlaidItem (would prevent deletion otherwise)
      //      - plaidAccountId — Plaid's external account_id string (just for cleanliness)
      if (linkedAccountCount > 0) {
        await tx.account.updateMany({
          where: { plaidItemId: plaidItem.id },
          data: { plaidItemId: null, plaidAccountId: null },
        });
        console.log(`[hard-delete] Unlinked ${linkedAccountCount} account(s) from PlaidItem ${plaidItem.id}`);
      }

      // b) Delete the PlaidItem.
      //    PlaidTransaction (onDelete: Cascade) and PlaidSyncLog (onDelete: Cascade)
      //    are removed automatically by Postgres/Prisma.
      await tx.plaidItem.delete({ where: { id: plaidItem.id } });
    });

    console.log(
      `[hard-delete] Successfully deleted PlaidItem ${plaidItem.id}. ` +
      `Accounts unlinked: ${linkedAccountCount}, PlaidTransactions removed: ${plaidTxCount}, SyncLogs removed: ${syncLogCount}`
    );

    return res.status(StatusCodes.OK).json({
      deleted: true,
      plaidItemId: plaidItem.id,
      institutionName: plaidItem.institutionName ?? null,
      tenantId: plaidItem.tenantId,
      summary: {
        accountsUnlinked: linkedAccountCount,
        plaidTransactionsDeleted: plaidTxCount,
        syncLogsDeleted: syncLogCount,
        transactionsPreserved: true,
        plaidTokenRevoked: plaidRemoveResult !== null,
      },
    });
  } catch (error) {
    Sentry.captureException(error);
    console.error('[hard-delete] Unexpected error:', error.message, error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Hard delete failed',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
}
