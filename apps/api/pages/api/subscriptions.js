/**
 * Subscriptions & recurring charges.
 *
 *   GET /api/subscriptions?view=active|lapsed|all&categoryId=<id>
 *     Returns the tenant's detected recurring charges (one row per merchant),
 *     each converted into the tenant's display currency, plus a monthly +
 *     annual recurring-spend summary (ACTIVE + fx-available rows only).
 *
 *   POST /api/subscriptions
 *     Body: { action, ... }
 *       confirm    { descriptionHash } | { transactionId }
 *       dismiss    { descriptionHash }
 *       restore    { descriptionHash }
 *       setCadence { descriptionHash, cadence }
 *       rename     { descriptionHash, merchantLabel }                → user label, kept across scans
 *       merge      { sourceDescriptionHash, targetDescriptionHash }  → folds source merchant into target
 *       unmerge    { descriptionHash }                               → undoes a merge
 *       refresh                              → 202 (enqueues an incremental scan; 30-min cooldown → 429)
 *       fullScan                             → 202 (enqueues a 48-month full scan; called from Settings → Maintenance)
 *
 * All queries scoped to req.user.tenantId. Detection itself runs in the
 * backend subscriptionDetectionWorker — this route never computes it inline.
 */

import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { Decimal } from '@prisma/client/runtime/library';

import prisma from '../../prisma/prisma.js';
import { cors } from '../../utils/cors.js';
import { rateLimiters } from '../../utils/rateLimit.js';
import { withAuth } from '../../utils/withAuth.js';
import { produceEvent } from '../../utils/produceEvent.js';
import { convertCurrency } from '../../utils/currencyConversion.js';
import { hashMerchant } from '../../utils/merchantNormalize.js';
import { getRefreshCooldownRemaining, armRefreshCooldown } from '../../utils/subscriptionCooldown.js';

const CADENCES = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL'];
const VIEWS = ['active', 'lapsed', 'all'];
const CADENCE_DAYS = { WEEKLY: 7, MONTHLY: 30, QUARTERLY: 91, ANNUAL: 365 };
// Mirrors SUBSCRIPTION_LAPSE_MULTIPLIER in the backend classificationConfig.js.
const LAPSE_MULTIPLIER = 1.5;

/**
 * ACTIVE while a charge landed within 1.5 × cadence of now; else LAPSED.
 * Mirrors computeStatus() in the backend recurringDetectionService — kept here
 * so a user cadence edit can un-lapse (or lapse) a row immediately instead of
 * waiting for the next detection run.
 */
function statusFrom(lastChargedAt, cadence) {
  if (!lastChargedAt || !CADENCE_DAYS[cadence]) return 'ACTIVE';
  const graceMs = CADENCE_DAYS[cadence] * LAPSE_MULTIPLIER * 86_400_000;
  return Date.now() - new Date(lastChargedAt).getTime() > graceMs ? 'LAPSED' : 'ACTIVE';
}

/** Factor to normalize one charge to a per-month figure. */
function monthlyFactor(cadence) {
  switch (cadence) {
    case 'WEEKLY': return 52 / 12;
    case 'MONTHLY': return 1;
    case 'QUARTERLY': return 1 / 3;
    case 'ANNUAL': return 1 / 12;
    default: return 1;
  }
}

function nextExpectedFrom(lastChargedAt, cadence) {
  if (!lastChargedAt || !CADENCE_DAYS[cadence]) return null;
  return new Date(new Date(lastChargedAt).getTime() + CADENCE_DAYS[cadence] * 86_400_000);
}

export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.subscriptions(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  try {
    const { tenantId } = req.user;

    switch (req.method) {
      case 'GET':
        return await handleGet(req, res, tenantId);
      case 'POST':
        return await handlePost(req, res, tenantId);
      default:
        res.setHeader('Allow', ['GET', 'POST']);
        return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
    }
  } catch (error) {
    console.error('Subscriptions error:', error);
    Sentry.captureException(error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});

async function handleGet(req, res, tenantId) {
  const view = VIEWS.includes(req.query.view) ? req.query.view : 'active';
  const categoryId = req.query.categoryId ? parseInt(req.query.categoryId, 10) : null;
  if (req.query.categoryId && Number.isNaN(categoryId)) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid categoryId' });
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { portfolioCurrency: true, subscriptionsFullScanAt: true },
  });
  const displayCurrency = tenant?.portfolioCurrency || 'USD';

  // `all` surfaces DISMISSED + merge tombstones too, so the UI can offer
  // "Restore" / "Unmerge". `active` / `lapsed` never show tombstones.
  const where = {
    tenantId,
    ...(view !== 'all' && { state: { not: 'DISMISSED' }, mergedIntoHash: null }),
    ...(view === 'active' && { status: 'ACTIVE' }),
    ...(view === 'lapsed' && { status: 'LAPSED' }),
    ...(categoryId && { categoryId }),
  };

  const rows = await prisma.recurringCharge.findMany({
    where,
    orderBy: [{ status: 'asc' }, { lastChargedAt: 'desc' }],
    include: { category: { select: { id: true, name: true, icon: true, isRecurring: true } } },
  });

  // Resolve merge-target labels for any merged tombstones in the result.
  const mergeTargetHashes = [...new Set(rows.filter((r) => r.mergedIntoHash).map((r) => r.mergedIntoHash))];
  const mergeTargets = mergeTargetHashes.length
    ? await prisma.recurringCharge.findMany({
        where: { tenantId, descriptionHash: { in: mergeTargetHashes } },
        select: { descriptionHash: true, merchantLabel: true },
      })
    : [];
  const mergeLabelByHash = Object.fromEntries(mergeTargets.map((r) => [r.descriptionHash, r.merchantLabel]));

  // Category facet for the filter dropdown — spans every non-dismissed row
  // regardless of the current view/category filter.
  const facetGroups = await prisma.recurringCharge.groupBy({
    by: ['categoryId'],
    where: { tenantId, state: { not: 'DISMISSED' }, mergedIntoHash: null },
    _count: { _all: true },
  });
  const facetCategories = await prisma.category.findMany({
    where: { tenantId, id: { in: facetGroups.map((g) => g.categoryId) } },
    select: { id: true, name: true, icon: true },
  });
  const facetCountById = Object.fromEntries(facetGroups.map((g) => [g.categoryId, g._count._all]));
  const categories = facetCategories
    .map((c) => ({ id: c.id, name: c.name, icon: c.icon, count: facetCountById[c.id] ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Merge picker candidates — every non-dismissed, non-merged row for the tenant,
  // independent of the current view/category filter, so a Lapsed row can still be
  // merged into an Active/Confirmed one.
  const mergeCandidateRows = await prisma.recurringCharge.findMany({
    where: { tenantId, state: { not: 'DISMISSED' }, mergedIntoHash: null },
    orderBy: [{ status: 'asc' }, { merchantLabel: 'asc' }],
    include: { category: { select: { icon: true, name: true } } },
  });
  const mergeCandidates = mergeCandidateRows.map((r) => ({
    descriptionHash: r.descriptionHash,
    merchantLabel: r.merchantLabel,
    status: r.status,
    state: r.state,
    categoryIcon: r.category?.icon ?? null,
    categoryName: r.category?.name ?? null,
  }));

  let monthlyTotal = new Decimal(0);
  let activeCount = 0;
  let lapsedCount = 0;
  let fxUnavailableCount = 0;
  let lastDetectedAt = null;

  const items = [];
  for (const row of rows) {
    const isTombstone = row.state === 'DISMISSED' || row.mergedIntoHash != null;
    if (!isTombstone && row.status === 'ACTIVE') activeCount += 1;
    if (!isTombstone && row.status === 'LAPSED') lapsedCount += 1;
    if (row.lastDetectedAt && (!lastDetectedAt || row.lastDetectedAt > lastDetectedAt)) {
      lastDetectedAt = row.lastDetectedAt;
    }

    let amountInDisplayCurrency = null;
    let monthlyAmount = null;
    let fxUnavailable = false;
    if (row.amount != null && row.currency) {
      const converted = await convertCurrency(
        row.amount,
        row.currency,
        displayCurrency,
        row.lastChargedAt || new Date(),
      );
      if (converted == null) {
        fxUnavailable = true;
        if (!isTombstone) fxUnavailableCount += 1;
      } else {
        amountInDisplayCurrency = new Decimal(converted);
        monthlyAmount = amountInDisplayCurrency.times(monthlyFactor(row.cadence));
        // Totals count ACTIVE, non-tombstone rows only.
        if (row.status === 'ACTIVE' && !isTombstone) {
          monthlyTotal = monthlyTotal.plus(monthlyAmount);
        }
      }
    }

    items.push({
      id: row.id,
      descriptionHash: row.descriptionHash,
      merchantLabel: row.merchantLabel,
      categoryId: row.categoryId,
      category: row.category
        ? { id: row.category.id, name: row.category.name, icon: row.category.icon }
        : null,
      state: row.state,
      cadence: row.cadence,
      userCadenceLocked: row.userCadenceLocked,
      userLabelLocked: row.userLabelLocked,
      status: row.status,
      detectionReason: row.detectionReason,
      amount: row.amount != null ? Number(row.amount) : null,
      currency: row.currency,
      amountInDisplayCurrency: amountInDisplayCurrency != null ? Number(amountInDisplayCurrency) : null,
      monthlyAmount: monthlyAmount != null ? Number(monthlyAmount) : null,
      fxUnavailable,
      occurrenceCount: row.occurrenceCount,
      firstChargedAt: row.firstChargedAt,
      lastChargedAt: row.lastChargedAt,
      nextExpectedAt: row.nextExpectedAt,
      lastDetectedAt: row.lastDetectedAt,
      contributingTransactionIds: row.contributingTransactionIds,
      mergedIntoHash: row.mergedIntoHash ?? null,
      mergedIntoLabel: row.mergedIntoHash ? (mergeLabelByHash[row.mergedIntoHash] ?? null) : null,
    });
  }

  const cooldownRemaining = await getRefreshCooldownRemaining(tenantId);

  return res.status(StatusCodes.OK).json({
    displayCurrency,
    lastDetectedAt,
    fullScanAt: tenant?.subscriptionsFullScanAt ?? null,
    refreshCooldownSeconds: cooldownRemaining,
    categories,
    mergeCandidates,
    summary: {
      monthlyTotal: Number(monthlyTotal),
      annualTotal: Number(monthlyTotal.times(12)),
      activeCount,
      lapsedCount,
      fxUnavailableCount,
    },
    items,
  });
}

async function handlePost(req, res, tenantId) {
  const { action } = req.body || {};

  switch (action) {
    case 'confirm':
      return await handleConfirm(req, res, tenantId);
    case 'dismiss':
      return await handleDismiss(req, res, tenantId);
    case 'restore':
      return await handleRestore(req, res, tenantId);
    case 'setCadence':
      return await handleSetCadence(req, res, tenantId);
    case 'rename':
      return await handleRename(req, res, tenantId);
    case 'merge':
      return await handleMerge(req, res, tenantId);
    case 'unmerge':
      return await handleUnmerge(req, res, tenantId);
    case 'refresh':
      return await handleScan(req, res, tenantId, 'incremental');
    case 'fullScan':
      return await handleScan(req, res, tenantId, 'full');
    default:
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'action must be one of: confirm, dismiss, restore, setCadence, rename, merge, unmerge, refresh, fullScan',
      });
  }
}

async function handleConfirm(req, res, tenantId) {
  const { descriptionHash, transactionId } = req.body || {};

  if (transactionId) {
    const txn = await prisma.transaction.findFirst({
      where: { id: parseInt(transactionId, 10), tenantId },
      select: { id: true, description: true, categoryId: true, debit: true, currency: true, transaction_date: true },
    });
    if (!txn) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: 'Transaction not found in this tenant' });
    }
    const hash = hashMerchant(txn.description);
    const chargedAt = txn.transaction_date;
    const existing = await prisma.recurringCharge.findUnique({
      where: { tenantId_descriptionHash: { tenantId, descriptionHash: hash } },
      select: { id: true },
    });
    const row = await prisma.recurringCharge.upsert({
      where: { tenantId_descriptionHash: { tenantId, descriptionHash: hash } },
      create: {
        tenantId,
        descriptionHash: hash,
        merchantLabel: (txn.description || '').slice(0, 140),
        categoryId: txn.categoryId,
        state: 'CONFIRMED',
        detectionReason: 'USER_CONFIRMED',
        cadence: 'MONTHLY',
        status: 'ACTIVE',
        amount: txn.debit ?? null,
        currency: txn.currency,
        occurrenceCount: 1,
        firstChargedAt: chargedAt,
        lastChargedAt: chargedAt,
        nextExpectedAt: nextExpectedFrom(chargedAt, 'MONTHLY'),
        contributingTransactionIds: [txn.id],
        lastDetectedAt: new Date(),
      },
      update: { state: 'CONFIRMED', detectionReason: 'USER_CONFIRMED' },
    });
    return res.status(existing ? StatusCodes.OK : StatusCodes.CREATED).json(serialize(row));
  }

  if (!descriptionHash) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'confirm requires descriptionHash or transactionId' });
  }
  const result = await prisma.recurringCharge.updateMany({
    where: { tenantId, descriptionHash },
    data: { state: 'CONFIRMED', detectionReason: 'USER_CONFIRMED' },
  });
  if (result.count === 0) {
    return res.status(StatusCodes.NOT_FOUND).json({ error: 'No recurring charge with that descriptionHash' });
  }
  return res.status(StatusCodes.OK).json({ updated: result.count });
}

async function handleDismiss(req, res, tenantId) {
  const { descriptionHash } = req.body || {};
  if (!descriptionHash) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'dismiss requires descriptionHash' });
  }
  const result = await prisma.recurringCharge.updateMany({
    where: { tenantId, descriptionHash },
    data: {
      state: 'DISMISSED',
      status: 'ACTIVE',
      nextExpectedAt: null,
      contributingTransactionIds: [],
    },
  });
  if (result.count === 0) {
    return res.status(StatusCodes.NOT_FOUND).json({ error: 'No recurring charge with that descriptionHash' });
  }
  return res.status(StatusCodes.OK).json({ updated: result.count });
}

async function handleRestore(req, res, tenantId) {
  const { descriptionHash } = req.body || {};
  if (!descriptionHash) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'restore requires descriptionHash' });
  }
  const result = await prisma.recurringCharge.deleteMany({
    where: { tenantId, descriptionHash, state: 'DISMISSED' },
  });
  if (result.count === 0) {
    return res.status(StatusCodes.NOT_FOUND).json({ error: 'No dismissed recurring charge with that descriptionHash' });
  }
  return res.status(StatusCodes.OK).json({ restored: result.count });
}

async function handleSetCadence(req, res, tenantId) {
  const { descriptionHash, cadence } = req.body || {};
  if (!descriptionHash || !CADENCES.includes(cadence)) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: `setCadence requires descriptionHash and cadence ∈ {${CADENCES.join(', ')}}`,
    });
  }
  const row = await prisma.recurringCharge.findUnique({
    where: { tenantId_descriptionHash: { tenantId, descriptionHash } },
  });
  if (!row) {
    return res.status(StatusCodes.NOT_FOUND).json({ error: 'No recurring charge with that descriptionHash' });
  }
  const updated = await prisma.recurringCharge.update({
    where: { tenantId_descriptionHash: { tenantId, descriptionHash } },
    data: {
      cadence,
      userCadenceLocked: true,
      nextExpectedAt: nextExpectedFrom(row.lastChargedAt, cadence),
      // Recompute lapsed/active against the new cadence right away — otherwise a
      // wrongly-monthly annual subscription stays stuck in the Lapsed tab until
      // the next detection run.
      status: statusFrom(row.lastChargedAt, cadence),
    },
  });
  return res.status(StatusCodes.OK).json(serialize(updated));
}

/**
 * Give a recurring charge a custom display name. Sets `userLabelLocked` so the
 * detector stops overwriting `merchantLabel` from the latest bank descriptor on
 * every subsequent run.
 */
async function handleRename(req, res, tenantId) {
  const { descriptionHash } = req.body || {};
  const merchantLabel = typeof req.body?.merchantLabel === 'string' ? req.body.merchantLabel.trim() : '';
  if (!descriptionHash || !merchantLabel) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'rename requires descriptionHash and a non-empty merchantLabel' });
  }
  if (merchantLabel.length > 140) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'merchantLabel must be 140 characters or fewer' });
  }
  const row = await prisma.recurringCharge.findUnique({
    where: { tenantId_descriptionHash: { tenantId, descriptionHash } },
    select: { id: true },
  });
  if (!row) {
    return res.status(StatusCodes.NOT_FOUND).json({ error: 'No recurring charge with that descriptionHash' });
  }
  const updated = await prisma.recurringCharge.update({
    where: { tenantId_descriptionHash: { tenantId, descriptionHash } },
    data: { merchantLabel, userLabelLocked: true },
  });
  return res.status(StatusCodes.OK).json(serialize(updated));
}

/**
 * Fold one merchant's row into another so both feed a single subscription.
 * The automatic normalizer keeps genuinely-same services apart when the bank
 * descriptors diverge too much (e.g. "Orange" vs "To Orange Espagne S.a.");
 * this lets the user stitch them together persistently.
 *
 * The source row becomes a merge tombstone: `mergedIntoHash` is set to the
 * SHA-256 of the target's normalized merchant, and every subsequent detection
 * run folds the source merchant's transactions into the target's row. Hidden
 * from Active/Lapsed, shown under "All" with an Unmerge action.
 */
async function handleMerge(req, res, tenantId) {
  const { sourceDescriptionHash, targetDescriptionHash } = req.body || {};
  if (!sourceDescriptionHash || !targetDescriptionHash) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'merge requires sourceDescriptionHash and targetDescriptionHash',
    });
  }
  if (sourceDescriptionHash === targetDescriptionHash) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Cannot merge a subscription into itself' });
  }

  const [source, target] = await Promise.all([
    prisma.recurringCharge.findUnique({
      where: { tenantId_descriptionHash: { tenantId, descriptionHash: sourceDescriptionHash } },
    }),
    prisma.recurringCharge.findUnique({
      where: { tenantId_descriptionHash: { tenantId, descriptionHash: targetDescriptionHash } },
    }),
  ]);
  if (!source) {
    return res.status(StatusCodes.NOT_FOUND).json({ error: 'No recurring charge with that sourceDescriptionHash' });
  }
  if (!target) {
    return res.status(StatusCodes.NOT_FOUND).json({ error: 'No recurring charge with that targetDescriptionHash' });
  }
  if (source.mergedIntoHash) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'That subscription is already merged into another' });
  }
  if (target.mergedIntoHash) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Cannot merge into a subscription that is itself merged — pick its target instead',
    });
  }

  // The detector folds by `sha256(normalizeMerchant(targetMerchant))` — the
  // bare-merchant hash of the target, which for a regular (non-clustered) row
  // equals its own descriptionHash.
  const targetMerchantHash = hashMerchant(target.merchantLabel || '');
  if (targetMerchantHash === sourceDescriptionHash) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Those two rows already resolve to the same merchant',
    });
  }

  await prisma.recurringCharge.update({
    where: { tenantId_descriptionHash: { tenantId, descriptionHash: sourceDescriptionHash } },
    data: {
      mergedIntoHash: targetMerchantHash,
      status: 'ACTIVE',
      nextExpectedAt: null,
      contributingTransactionIds: [],
    },
  });

  // Rescan so the target row absorbs the source merchant's charges now — not on
  // the next nightly run. No cooldown: this is a targeted, cheap re-fold.
  await produceEvent({
    type: 'SUBSCRIPTION_DETECTION_REQUESTED',
    tenantId,
    mode: 'incremental',
    source: 'merge',
  });

  return res.status(StatusCodes.OK).json({ merged: 1, mergedIntoHash: targetMerchantHash });
}

/** Undo a merge — the source row goes back to being detected on its own. */
async function handleUnmerge(req, res, tenantId) {
  const { descriptionHash } = req.body || {};
  if (!descriptionHash) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'unmerge requires descriptionHash' });
  }
  const result = await prisma.recurringCharge.updateMany({
    where: { tenantId, descriptionHash, mergedIntoHash: { not: null } },
    data: { mergedIntoHash: null },
  });
  if (result.count === 0) {
    return res.status(StatusCodes.NOT_FOUND).json({ error: 'No merged recurring charge with that descriptionHash' });
  }

  await produceEvent({
    type: 'SUBSCRIPTION_DETECTION_REQUESTED',
    tenantId,
    mode: 'incremental',
    source: 'unmerge',
  });

  return res.status(StatusCodes.OK).json({ unmerged: result.count });
}

async function handleScan(req, res, tenantId, mode) {
  if (mode === 'incremental') {
    const remaining = await getRefreshCooldownRemaining(tenantId);
    if (remaining > 0) {
      return res.status(StatusCodes.TOO_MANY_REQUESTS).json({
        error: 'A scan was run recently. Try again shortly.',
        retryAfter: remaining,
      });
    }
    await armRefreshCooldown(tenantId);
  }

  await produceEvent({
    type: 'SUBSCRIPTION_DETECTION_REQUESTED',
    tenantId,
    mode,
    source: mode === 'full' ? 'maintenance' : 'subscriptions-page',
  });

  return res.status(StatusCodes.ACCEPTED).json({ status: 'accepted', mode });
}

function serialize(row) {
  return {
    ...row,
    amount: row.amount != null ? Number(row.amount) : null,
  };
}
