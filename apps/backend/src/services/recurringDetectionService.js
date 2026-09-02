/**
 * Recurring-charge (subscription) detection.
 *
 * Deterministic — no LLM. Two tiers:
 *
 *   Tier A — category signal (primary). Transactions whose Category has
 *            `isRecurring = true`. One occurrence qualifies (PRD "Category
 *            signal reuse"). The `isRecurring` join is on an UNENCRYPTED
 *            column so the DB does the filtering; only this small set is
 *            loaded and decrypted.
 *
 *   Tier B — bounded interval heuristic (fallback). Spending-type transactions
 *            in NON-recurring categories, 6-month window, row-cap guarded.
 *            Needs >= SUBSCRIPTION_MIN_OCCURRENCES regular occurrences at a
 *            stable amount, and a median inter-charge gap in the WEEKLY or
 *            MONTHLY bucket.
 *
 * Learning loop: per-merchant CONFIRMED / DISMISSED rows (keyed by
 * hashMerchant(description)) are honoured on every run — DISMISSED merchants
 * are never re-surfaced, CONFIRMED merchants are always included even if the
 * heuristic wouldn't pick them up this run.
 *
 * The detection WORKER (subscriptionDetectionWorker.js) persists the returned
 * rows via upsert and prunes stale DETECTED rows. This service is pure read +
 * compute so it is trivially unit-testable.
 */

const crypto = require('crypto');
const { Decimal } = require('@prisma/client/runtime/library');
const prisma = require('../../prisma/prisma');
const logger = require('../utils/logger');
const {
  SUBSCRIPTION_INCREMENTAL_MONTHS,
  SUBSCRIPTION_FULL_SCAN_MONTHS,
  SUBSCRIPTION_TIER_B_ROW_CAP,
  SUBSCRIPTION_MIN_OCCURRENCES,
  SUBSCRIPTION_AMOUNT_DRIFT_PCT,
  SUBSCRIPTION_AMOUNT_DRIFT_ABS,
  SUBSCRIPTION_GAP_CV_MAX,
  SUBSCRIPTION_LAPSE_MULTIPLIER,
  SUBSCRIPTION_MAX_CONTRIBUTING_IDS,
  SUBSCRIPTION_CADENCE_BUCKETS,
} = require('../config/classificationConfig');

const BATCH_SIZE = 1000;
const SPENDING_TYPES = ['Essentials', 'Lifestyle', 'Growth'];

/** Nominal length of one cadence period, in days. Used for next-expected-charge
 *  and lapse computation (never for detection — that uses the bucket ranges). */
const CADENCE_DAYS = { WEEKLY: 7, MONTHLY: 30, QUARTERLY: 91, ANNUAL: 365 };

// ─── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Normalize a raw transaction description to a stable merchant key.
 *
 * MUST stay byte-identical to apps/api/utils/merchantNormalize.js (ESM mirror)
 * so the API's "confirm from a transaction" path produces the same hash as the
 * worker.
 */
function normalizeMerchant(description) {
  return String(description || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')  // strip accents
    .replace(/\bx{2,}\d+\b/g, ' ')                          // masked card numbers: xxxx1234
    .replace(/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/g, ' ')  // dates: 04/12, 2026-01-03
    .replace(/#?\s?\d{3,}/g, ' ')                           // store / ref numbers: "#00421", "0345521"
    .replace(/[^a-z0-9&]+/g, ' ')                           // collapse punctuation to space
    .replace(/\b(purchase|payment|pos|debit|card|recurring|autopay|ppd|id|ref|trace)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** SHA-256 hex of the normalized merchant key. */
function hashMerchant(description) {
  return crypto.createHash('sha256').update(normalizeMerchant(description)).digest('hex');
}

function toNumber(v) {
  if (v == null) return 0;
  if (v instanceof Decimal) return v.toNumber();
  return Number(v);
}

function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function stddev(nums) {
  if (nums.length < 2) return 0;
  const m = mean(nums);
  return Math.sqrt(mean(nums.map((n) => (n - m) ** 2)));
}

/**
 * True when every amount is within the drift tolerance of the median
 * (relative OR absolute, whichever is more permissive).
 */
function isAmountStable(amounts) {
  if (amounts.length < 2) return true;
  const med = median(amounts);
  const tol = Math.max(Math.abs(med) * SUBSCRIPTION_AMOUNT_DRIFT_PCT, SUBSCRIPTION_AMOUNT_DRIFT_ABS);
  return amounts.every((a) => Math.abs(a - med) <= tol);
}

/** Which cadence bucket, if any, a median gap (days) falls in. */
function bucketForGap(days) {
  for (const [cadence, [lo, hi]] of Object.entries(SUBSCRIPTION_CADENCE_BUCKETS)) {
    if (days >= lo && days <= hi) return cadence;
  }
  return null;
}

/**
 * Infer a cadence from a sorted (asc) list of Date occurrences.
 * @returns {{ cadence: string|null, medianGapDays: number, gapCv: number }}
 */
function inferCadence(sortedDates) {
  if (sortedDates.length < 2) {
    return { cadence: null, medianGapDays: 0, gapCv: 0 };
  }
  const gaps = [];
  for (let i = 1; i < sortedDates.length; i++) {
    gaps.push((sortedDates[i].getTime() - sortedDates[i - 1].getTime()) / 86_400_000);
  }
  const medianGapDays = median(gaps);
  const gapCv = medianGapDays > 0 ? stddev(gaps) / mean(gaps) : Infinity;
  return { cadence: bucketForGap(medianGapDays), medianGapDays, gapCv };
}

/** Next expected charge = last charge + one nominal cadence period. */
function computeNextExpected(lastChargedAt, cadence) {
  if (!lastChargedAt || !cadence || !CADENCE_DAYS[cadence]) return null;
  return new Date(lastChargedAt.getTime() + CADENCE_DAYS[cadence] * 86_400_000);
}

/** ACTIVE while a charge landed within 1.5 × cadence of `now`; else LAPSED. */
function computeStatus(lastChargedAt, cadence, now = new Date()) {
  if (!lastChargedAt || !cadence || !CADENCE_DAYS[cadence]) return 'ACTIVE';
  const graceMs = CADENCE_DAYS[cadence] * SUBSCRIPTION_LAPSE_MULTIPLIER * 86_400_000;
  return now.getTime() - lastChargedAt.getTime() > graceMs ? 'LAPSED' : 'ACTIVE';
}

function isCategoryRecurring(category) {
  return category?.isRecurring === true;
}

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
}

function dominantValue(values) {
  const counts = new Map();
  let best = values[0];
  let bestCount = 0;
  for (const v of values) {
    const c = (counts.get(v) || 0) + 1;
    counts.set(v, c);
    if (c > bestCount) { bestCount = c; best = v; }
  }
  return best;
}

// ─── DB loading ─────────────────────────────────────────────────────────────

const TXN_SELECT = {
  id: true,
  description: true,
  debit: true,
  currency: true,
  transaction_date: true,
  categoryId: true,
  category: { select: { id: true, name: true, icon: true, isRecurring: true, type: true } },
};

async function loadTransactionsBatched(where) {
  const out = [];
  let cursor = null;
  for (;;) {
    const batch = await prisma.transaction.findMany({
      where,
      select: TXN_SELECT,
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (batch.length === 0) break;
    out.push(...batch);
    cursor = batch[batch.length - 1].id;
    if (batch.length < BATCH_SIZE) break;
  }
  return out;
}

// ─── Main entry point ──────────────────────────────────────────────────────

/**
 * Detect recurring charges for one tenant.
 *
 * @param {string} tenantId
 * @param {{ mode?: 'incremental'|'full' }} [opts]
 * @returns {Promise<{ rows: object[], tierACount: number, tierBCount: number, tierBSkipped: boolean }>}
 */
async function detectForTenant(tenantId, { mode = 'incremental' } = {}) {
  const now = new Date();
  const tierAStart = mode === 'full' ? monthsAgo(SUBSCRIPTION_FULL_SCAN_MONTHS) : monthsAgo(SUBSCRIPTION_INCREMENTAL_MONTHS);
  const tierBStart = monthsAgo(SUBSCRIPTION_INCREMENTAL_MONTHS);

  // 1. Existing user decisions -----------------------------------------------
  const priorRows = await prisma.recurringCharge.findMany({
    where: { tenantId, OR: [{ state: { in: ['CONFIRMED', 'DISMISSED'] } }, { userCadenceLocked: true }] },
    select: { descriptionHash: true, state: true, cadence: true, userCadenceLocked: true },
  });
  const dismissed = new Set();
  const confirmed = new Set();
  const lockedCadence = new Map();
  for (const r of priorRows) {
    if (r.state === 'DISMISSED') dismissed.add(r.descriptionHash);
    if (r.state === 'CONFIRMED') confirmed.add(r.descriptionHash);
    if (r.userCadenceLocked && r.cadence) lockedCadence.set(r.descriptionHash, r.cadence);
  }

  // 2. Tier A load ----------------------------------------------------------
  const tierATxns = await loadTransactionsBatched({
    tenantId,
    debit: { not: null },
    transaction_date: { gte: tierAStart },
    category: { is: { isRecurring: true } },
  });

  // 3. Tier B load (row-cap guarded) --------------------------------------
  const tierBWhere = {
    tenantId,
    debit: { not: null },
    transaction_date: { gte: tierBStart },
    category: { is: { isRecurring: false, type: { in: SPENDING_TYPES } } },
  };
  const tierBCountRaw = await prisma.transaction.count({ where: tierBWhere });
  let tierBTxns = [];
  let tierBSkipped = false;
  if (tierBCountRaw > SUBSCRIPTION_TIER_B_ROW_CAP) {
    tierBSkipped = true;
    logger.warn('[recurringDetection] Tier B skipped — row cap exceeded', {
      tenantId, tierBCount: tierBCountRaw, cap: SUBSCRIPTION_TIER_B_ROW_CAP,
    });
  } else {
    tierBTxns = await loadTransactionsBatched(tierBWhere);
  }

  // 4. Group by merchant hash --------------------------------------------
  const groups = new Map();
  for (const txn of [...tierATxns, ...tierBTxns]) {
    const hash = hashMerchant(txn.description);
    if (!groups.has(hash)) groups.set(hash, []);
    groups.get(hash).push(txn);
  }

  // 5. Qualify + build rows --------------------------------------------
  const rows = [];
  for (const [hash, occ] of groups.entries()) {
    if (dismissed.has(hash)) continue; // tombstoned — never re-surface

    occ.sort((a, b) => a.transaction_date - b.transaction_date);
    const dates = occ.map((t) => t.transaction_date);
    const isConfirmed = confirmed.has(hash);
    const tierA = occ.some((t) => isCategoryRecurring(t.category));

    const currency = dominantValue(occ.map((t) => t.currency));
    const nativeAmounts = occ.filter((t) => t.currency === currency).map((t) => toNumber(t.debit));
    const inferred = inferCadence(dates);

    // Cadence resolution
    let cadence = lockedCadence.get(hash) || null;
    if (!cadence) {
      if (tierA) {
        cadence = occ.length >= 2 ? (inferred.cadence || 'MONTHLY') : 'MONTHLY';
      } else {
        cadence = inferred.cadence; // Tier B — must be a real bucket (below gate)
      }
    }

    let detectionReason;
    if (isConfirmed) {
      detectionReason = 'USER_CONFIRMED';
    } else if (tierA) {
      detectionReason = 'CATEGORY_SIGNAL';
    } else {
      // Tier B gate
      const regular =
        occ.length >= SUBSCRIPTION_MIN_OCCURRENCES &&
        inferred.gapCv <= SUBSCRIPTION_GAP_CV_MAX &&
        (inferred.cadence === 'WEEKLY' || inferred.cadence === 'MONTHLY') &&
        isAmountStable(nativeAmounts);
      if (!regular) continue;
      detectionReason = 'INTERVAL_HEURISTIC';
    }

    if (!cadence) cadence = 'MONTHLY'; // safety net for a confirmed single-occurrence merchant

    const lastChargedAt = dates[dates.length - 1];
    const recentIds = occ
      .slice()
      .sort((a, b) => b.transaction_date - a.transaction_date)
      .slice(0, SUBSCRIPTION_MAX_CONTRIBUTING_IDS)
      .map((t) => t.id);
    const mostRecent = occ[occ.length - 1];

    rows.push({
      descriptionHash: hash,
      merchantLabel: (mostRecent.description || '').slice(0, 140),
      categoryId: mostRecent.categoryId,
      cadence,
      amount: new Decimal(median(nativeAmounts) || toNumber(mostRecent.debit)),
      currency,
      occurrenceCount: occ.length,
      firstChargedAt: dates[0],
      lastChargedAt,
      nextExpectedAt: computeNextExpected(lastChargedAt, cadence),
      status: computeStatus(lastChargedAt, cadence, now),
      detectionReason,
      contributingTransactionIds: recentIds,
      lastDetectedAt: now,
      _isConfirmed: isConfirmed,
    });
  }

  return { rows, tierACount: tierATxns.length, tierBCount: tierBTxns.length, tierBSkipped };
}

module.exports = {
  detectForTenant,
  normalizeMerchant,
  hashMerchant,
  median,
  isAmountStable,
  inferCadence,
  bucketForGap,
  computeNextExpected,
  computeStatus,
  isCategoryRecurring,
  CADENCE_DAYS,
  SPENDING_TYPES,
};
