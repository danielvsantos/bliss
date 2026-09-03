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
 *            (Essentials / Lifestyle / Growth / Ventures) in NON-recurring
 *            categories, 6-month window, row-cap guarded. Needs
 *            >= SUBSCRIPTION_MIN_OCCURRENCES regular occurrences at a stable
 *            amount, and a median inter-charge gap in the WEEKLY or MONTHLY
 *            bucket.
 *
 *   Amount clustering — aggregator merchants (Apple App Store, Amazon, PayPal)
 *            whose charges span clearly separated amount bands are split into
 *            one row per band, so a meaningful per-price subscription surfaces
 *            instead of one row with a median amount and a dense weekly series.
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
  SUBSCRIPTION_CLUSTER_MIN_GROUP,
} = require('../config/classificationConfig');

const BATCH_SIZE = 1000;
// Category types the Tier-B interval heuristic scans. Includes `Ventures` so
// business subscriptions (Cloud & Hosting, SaaS & Tools, Data & API Services,
// domains, recurring ad spend) are caught even before the user flags those
// categories as recurring. `Income` / `Investments` / `Debt` / `Transfers` /
// `Asset` are excluded — recurrence there is not "a subscription".
const SPENDING_TYPES = ['Essentials', 'Lifestyle', 'Growth', 'Ventures'];

/** Nominal length of one cadence period, in days. Used for next-expected-charge
 *  and lapse computation (never for detection — that uses the bucket ranges). */
const CADENCE_DAYS = { WEEKLY: 7, MONTHLY: 30, QUARTERLY: 91, ANNUAL: 365 };

// ─── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Normalize a raw transaction description to a stable merchant key.
 *
 * The goal is that noisy real-world variants of the same merchant land on one
 * key: "Netflix", "NETFLIX.COM", "SQ *NETFLIX", "NETFLIX 08/15 POS DEBIT",
 * "Netflix Inc", "Netflix 4" all \u2192 "netflix". It is deliberately conservative \u2014
 * it never merges on a shared first word, so "Netflix" and "Netflix Games" stay
 * distinct. Remaining gaps (word-order changes, abbreviations, brand rename) are
 * left to the per-merchant Confirm/Dismiss learning loop and, later, manual
 * merge.
 *
 * MUST stay byte-identical to apps/api/utils/merchantNormalize.js (ESM mirror)
 * so the API's "confirm from a transaction" path produces the same hash as the
 * worker.
 */
function normalizeMerchant(description) {
  const cleaned = String(description || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')     // strip accents
    .replace(/^\s*(?:sq|sqc|tst|pp|pyp|ppl|dd|cke|clv|sp|py|paypal|pos)\s*\*+\s*/, ' ') // payment-aggregator prefix: "SQ *", "PAYPAL *", "TST*" (allow-list \u2014 never a merchant's own name)
    .replace(/\bwww\./g, ' ')                              // URL prefix: "www.audible.com" -> "audible.com"
    .replace(/\.(?:com|net|org|io|co|app|dev|ai|tv|fm|gg|me|shop|store|xyz|cloud|info|biz)\b/g, ' ') // TLDs
    .replace(/\bx{2,}\d+\b/g, ' ')                         // masked card numbers: xxxx1234
    .replace(/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/g, ' ') // dates: 04/12, 2026-01-03
    .replace(/#?\s?\d{3,}/g, ' ')                          // store / ref numbers: "#00421", "0345521"
    .replace(/[^a-z0-9&]+/g, ' ')                          // collapse punctuation to space
    .replace(/\b(purchase|payment|pos|debit|card|recurring|autopay|ppd|id|ref|trace|www|http|https)\b/g, ' ')
    .replace(/\b(inc|llc|ltd|corp|gmbh|plc|lp|llp)\b\s*$/, ' ') // trailing corporate suffix
    .replace(/\s+/g, ' ')
    .trim();

  // Drop a trailing run of 1-2 digit tokens (bank-statement sequence artifacts:
  // "NETFLIX 4", "SODEXO 07"). Longer digit runs were already handled as ref
  // numbers above. Keep the original if stripping would empty the key.
  const deSuffixed = cleaned.replace(/(?:\s+\d{1,2})+$/, '').trim();
  return deSuffixed || cleaned;
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

/** SHA-256 hex of the normalized merchant key (from a raw description). */
function hashMerchant(description) {
  return sha256Hex(normalizeMerchant(description));
}

/**
 * Stable per-amount-band suffix for a split merchant's key. Rounds to a whole
 * currency unit so sub-unit drift (9.99 → 10.49) keeps the same key.
 */
function clusterKey(medianAmount) {
  return String(Math.max(1, Math.round(medianAmount)));
}

/**
 * Split a merchant's occurrences into amount bands.
 *
 * Aggregator merchants (Apple App Store, Amazon, PayPal) bill many unrelated
 * things under one descriptor; grouping only by merchant then produces a single
 * row with a meaningless median amount and a dense (→ weekly) date series. This
 * separates the charges into bands so each real recurring price becomes its own
 * row.
 *
 * Returns `[occurrences]` unchanged when the merchant is small
 * (< SUBSCRIPTION_CLUSTER_MIN_GROUP occurrences) or when every charge lands in
 * one band — so normal single-price merchants are completely unaffected.
 *
 * @param {Array<{ debit: * }>} occurrences  same-currency occurrences
 * @returns {Array<Array>}  one array of occurrences per band
 */
function clusterByAmount(occurrences) {
  if (occurrences.length < SUBSCRIPTION_CLUSTER_MIN_GROUP) return [occurrences];

  const sorted = [...occurrences].sort((a, b) => toNumber(a.debit) - toNumber(b.debit));
  const clusters = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = toNumber(sorted[i - 1].debit);
    const curr = toNumber(sorted[i].debit);
    const tol = Math.max(Math.abs(prev) * SUBSCRIPTION_AMOUNT_DRIFT_PCT, SUBSCRIPTION_AMOUNT_DRIFT_ABS);
    if (curr - prev > tol) clusters.push([sorted[i]]);
    else clusters[clusters.length - 1].push(sorted[i]);
  }
  return clusters.length > 1 ? clusters : [occurrences];
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

  // 1. Existing user decisions (merge tombstones excluded — a merged row's
  //    Confirm/Dismiss/locked-cadence no longer applies to a standalone row).
  const priorRows = await prisma.recurringCharge.findMany({
    where: {
      tenantId,
      mergedIntoHash: null,
      OR: [{ state: { in: ['CONFIRMED', 'DISMISSED'] } }, { userCadenceLocked: true }],
    },
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

  // 1b. Manual merges — sourceMerchantHash → targetMerchantHash, chains resolved.
  const aliasRows = await prisma.recurringCharge.findMany({
    where: { tenantId, mergedIntoHash: { not: null } },
    select: { descriptionHash: true, mergedIntoHash: true },
  });
  const aliasMap = new Map();
  {
    const raw = new Map(aliasRows.map((r) => [r.descriptionHash, r.mergedIntoHash]));
    const resolve = (h, seen) => {
      if (!raw.has(h) || seen.has(h)) return h;
      seen.add(h);
      return resolve(raw.get(h), seen);
    };
    for (const src of raw.keys()) aliasMap.set(src, resolve(src, new Set()));
  }
  // Target-row metadata, so a merge target with no charges this window still
  // gets a row from the merged-in charges alone.
  const aliasTargets = aliasMap.size
    ? await prisma.recurringCharge.findMany({
        where: { tenantId, descriptionHash: { in: [...new Set(aliasMap.values())] } },
        select: { descriptionHash: true, merchantLabel: true, categoryId: true, cadence: true, currency: true },
      })
    : [];
  const aliasTargetByHash = new Map(aliasTargets.map((r) => [r.descriptionHash, r]));

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

  // 4. Group by merchant key (normalized string) ------------------------
  const groups = new Map();
  for (const txn of [...tierATxns, ...tierBTxns]) {
    const key = normalizeMerchant(txn.description);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(txn);
  }

  // 4b. Fold merged-away merchants into their target -------------------
  const inboundByTargetHash = new Map(); // targetMerchantHash → occ[]
  for (const [key, occ] of [...groups.entries()]) {
    const target = aliasMap.get(sha256Hex(key));
    if (!target) continue;
    if (!inboundByTargetHash.has(target)) inboundByTargetHash.set(target, []);
    inboundByTargetHash.get(target).push(...occ);
    groups.delete(key); // never processed standalone again
  }

  // 5. Qualify + build rows (per merchant, then per amount band) --------
  const rows = [];
  const legacyRetireHashes = []; // bare merchant hashes whose single row is now split
  const consumedInbound = new Set();
  for (const [merchantKey, merchantOccRaw] of groups.entries()) {
    const merchantHash = sha256Hex(merchantKey);

    // Absorb any charges merged into this merchant.
    const mergedIn = inboundByTargetHash.get(merchantHash) || [];
    if (mergedIn.length) consumedInbound.add(merchantHash);
    const merchantOcc = mergedIn.length ? [...merchantOccRaw, ...mergedIn] : merchantOccRaw;

    // Dominant currency is picked per merchant; amount bands are computed within
    // that currency's charges only.
    const currency = dominantValue(merchantOcc.map((t) => t.currency));
    const domOcc = merchantOcc.filter((t) => t.currency === currency);

    // A merged row is a deliberate "these are one subscription" — don't re-split it.
    const bands = mergedIn.length ? [domOcc] : clusterByAmount(domOcc);
    const isSplit = bands.length > 1;
    if (isSplit) legacyRetireHashes.push(merchantHash);

    for (const band of bands) {
      const occ = [...band].sort((a, b) => a.transaction_date - b.transaction_date);
      const dates = occ.map((t) => t.transaction_date);
      const nativeAmounts = occ.map((t) => toNumber(t.debit));
      const med = median(nativeAmounts) || toNumber(occ[occ.length - 1].debit);

      const hash = isSplit ? sha256Hex(`${merchantKey}#${clusterKey(med)}`) : merchantHash;
      if (dismissed.has(hash)) continue; // tombstoned — never re-surface

      const isConfirmed = confirmed.has(hash);
      // A merged target is a deliberate "this is one subscription" — surface it
      // even if the combined series wouldn't pass the interval gate on its own.
      const forced = isConfirmed || mergedIn.length > 0;
      const tierA = occ.some((t) => isCategoryRecurring(t.category));
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
      if (forced) {
        detectionReason = isConfirmed ? 'USER_CONFIRMED' : (tierA ? 'CATEGORY_SIGNAL' : 'INTERVAL_HEURISTIC');
      } else if (tierA) {
        // A split band needs >= 2 occurrences to be a real recurring price — a
        // lone large App Store purchase must not become a subscription.
        if (isSplit && occ.length < 2) continue;
        detectionReason = 'CATEGORY_SIGNAL';
      } else {
        // Tier B gate — applied per band
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
      // When charges have been merged in, the folded-in transactions are often
      // the newest — but the user merged them into THIS row precisely because
      // its descriptor is the good one. Keep the target row's own label.
      const mergedMeta = mergedIn.length ? aliasTargetByHash.get(merchantHash) : null;
      const label = (mergedMeta?.merchantLabel || mostRecent.description || '').slice(0, 140);

      rows.push({
        descriptionHash: hash,
        merchantLabel: label,
        categoryId: mergedMeta?.categoryId ?? mostRecent.categoryId,
        cadence,
        amount: new Decimal(med),
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
  }

  // 5b. Merge targets that had no charges of their own this window still get a
  //     row, built from the merged-in charges + the target row's metadata.
  for (const [targetHash, mergedIn] of inboundByTargetHash.entries()) {
    if (consumedInbound.has(targetHash) || dismissed.has(targetHash)) continue;
    const occ = [...mergedIn].sort((a, b) => a.transaction_date - b.transaction_date);
    if (!occ.length) continue;
    const dates = occ.map((t) => t.transaction_date);
    const meta = aliasTargetByHash.get(targetHash);
    const currency = meta?.currency || dominantValue(occ.map((t) => t.currency));
    const amounts = occ.filter((t) => t.currency === currency).map((t) => toNumber(t.debit));
    const inferred = inferCadence(dates);
    const cadence = lockedCadence.get(targetHash)
      || meta?.cadence
      || inferred.cadence
      || 'MONTHLY';
    const lastChargedAt = dates[dates.length - 1];
    rows.push({
      descriptionHash: targetHash,
      merchantLabel: (meta?.merchantLabel || occ[occ.length - 1].description || '').slice(0, 140),
      categoryId: meta?.categoryId ?? occ[occ.length - 1].categoryId,
      cadence,
      amount: new Decimal(median(amounts) || toNumber(occ[occ.length - 1].debit)),
      currency,
      occurrenceCount: occ.length,
      firstChargedAt: dates[0],
      lastChargedAt,
      nextExpectedAt: computeNextExpected(lastChargedAt, cadence),
      status: computeStatus(lastChargedAt, cadence, now),
      detectionReason: confirmed.has(targetHash) ? 'USER_CONFIRMED' : 'INTERVAL_HEURISTIC',
      contributingTransactionIds: occ
        .slice()
        .sort((a, b) => b.transaction_date - a.transaction_date)
        .slice(0, SUBSCRIPTION_MAX_CONTRIBUTING_IDS)
        .map((t) => t.id),
      lastDetectedAt: now,
      _isConfirmed: confirmed.has(targetHash),
    });
  }

  return {
    rows,
    legacyRetireHashes,
    tierACount: tierATxns.length,
    tierBCount: tierBTxns.length,
    tierBSkipped,
  };
}

module.exports = {
  detectForTenant,
  normalizeMerchant,
  hashMerchant,
  sha256Hex,
  clusterByAmount,
  clusterKey,
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
