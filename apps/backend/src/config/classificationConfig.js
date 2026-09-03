/**
 * Centralized classification configuration.
 *
 * All tuning constants for the 4-tier classification waterfall live here.
 * Change values in this single file to adjust system-wide behavior.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONFIDENCE SCORE REFERENCE
 *
 * Source               | Score           | Typical range
 * ---------------------|-----------------|---------------
 * EXACT_MATCH          | Fixed constant  | always 1.00
 * VECTOR_MATCH         | Cosine sim.     | 0.70–1.00  (tenant-scoped)
 * VECTOR_MATCH_GLOBAL  | cosine × 0.92   | 0.64–0.92  (cross-tenant, discounted)
 * LLM                  | LLM-assigned    | 0.00–0.90  (hard-capped in classificationPromptHelpers)
 * LLM_UNKNOWN          | Fixed 0.0       | always 0.00 (model-declared ambiguous fallback)
 *
 * The 0.86–0.90 LLM band is the ABSOLUTE CERTAINTY tier — only valid when
 * the merchant is a globally recognized brand AND the Plaid hint matches
 * the chosen category AND the amount is typical. With the default 0.90
 * autoPromoteThreshold this is the only way an LLM classification
 * auto-promotes; tenants who want LLM never to auto-promote raise their
 * threshold to 0.91+.
 *
 * System actions by score (thresholds are per-tenant and stored in the DB;
 * the constants below are the defaults used when no DB record exists):
 *   ≥ autoPromoteThreshold (def. 0.90) → Transaction created automatically
 *   ≥ reviewThreshold      (def. 0.70) → Staged as CLASSIFIED for user review
 *   < reviewThreshold                  → Falls through to next classification tier
 *
 * More DB embeddings = better chance of finding a close neighbor, but the score
 * for a given match is always the cosine distance to the single nearest neighbor
 * (LIMIT 1 query) — not a cumulative or average score.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTE: The Prisma Tenant model (bliss-finance-api/prisma/schema.prisma, lines 42–43)
 * has matching @default values for autoPromoteThreshold and reviewThreshold.
 * Keep those in sync manually if you change the defaults here.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Tier 1: EXACT_MATCH ──────────────────────────────────────────────────────
/** Fixed confidence returned for any in-memory description-cache hit. */
const EXACT_MATCH_CONFIDENCE = 1;

// ── Tier 2: Vector similarity ────────────────────────────────────────────────
/** Discount factor applied to GlobalEmbedding matches (cross-tenant data is less
 *  trustworthy than the tenant's own confirmed transactions). */
const GLOBAL_VECTOR_DISCOUNT = 0.92;

/** Output dimensionality for the Gemini embedding model.
 *  The model defaults to 3072-dim; we project down to 768 for storage efficiency. */
const EMBEDDING_DIMENSIONS = 768;

// ── Tier 3: LLM ──────────────────────────────────────────────────────────────
/** Default number of days of Plaid transaction history fetched when a new bank is
 *  connected and enforced as a cutoff on every subsequent resync.
 *  Read from PLAID_HISTORY_DAYS env var so operators can tune it without code changes.
 *  The resolved value is written to Tenant.plaidHistoryDays at creation time; from
 *  then on, each tenant's DB value is the source of truth. */
const DEFAULT_PLAID_HISTORY_DAYS = parseInt(process.env.PLAID_HISTORY_DAYS ?? '1', 10);

/** Default auto-promote threshold. DB per-tenant value overrides this at runtime.
 *  Transactions at or above this score are automatically promoted to Transaction rows
 *  without requiring user review. */
const DEFAULT_AUTO_PROMOTE_THRESHOLD = 0.90;

/** Default review threshold. DB per-tenant value overrides this at runtime.
 *  Transactions below this score fall through to the next classification tier
 *  rather than being staged for user review. */
const DEFAULT_REVIEW_THRESHOLD = 0.70;

// ── Phase 1 / 2 processing ───────────────────────────────────────────────────
/** Maximum number of seed descriptions held for the Quick Seed interview.
 *  Phase 1 stops once this many seeds are accumulated. */
const TOP_N_SEEDS = 10;

/** Maximum concurrent LLM calls during Phase 2 classification.
 *  Kept low (5) to avoid bursting into Gemini's per-minute quota.
 *  Gemini Flash paid tier: ~2000 RPM; free tier: 15 RPM.
 *  5 concurrent × ~3s/call ≈ 100 RPM — safe headroom on paid, paced on free. */
const PHASE2_CONCURRENCY = 5;

// ── Subscriptions & recurring-charge detection ───────────────────────────────
// Consumed by services/recurringDetectionService.js + subscriptionDetectionWorker.js.
// Deterministic heuristic — no LLM. Tier A = category signal (isRecurring),
// Tier B = bounded interval heuristic over non-recurring spending categories.

/** Lookback window (months) for a nightly/on-demand "incremental" detection run.
 *  Also the hard cap on the Tier-B interval heuristic in every mode. */
const SUBSCRIPTION_INCREMENTAL_MONTHS = 6;

/** Lookback window (months) for an admin-triggered "full history scan".
 *  Only widens Tier A (category-pre-filtered, cheap) so ANNUAL / historical
 *  subscriptions surface. Tier B stays at SUBSCRIPTION_INCREMENTAL_MONTHS. */
const SUBSCRIPTION_FULL_SCAN_MONTHS = 48;

/** If a tenant has more than this many non-recurring spending-type transactions
 *  in the Tier-B window, Tier B is skipped (logged) — the category signal still
 *  runs and "confirm from a transaction" is still available. */
const SUBSCRIPTION_TIER_B_ROW_CAP = 8000;

/** Minimum occurrences for a merchant to qualify via the Tier-B interval heuristic. */
const SUBSCRIPTION_MIN_OCCURRENCES = 3;

/** Amount-drift tolerance for "same amount" — relative (5%) OR absolute (2 units),
 *  whichever is larger. Absorbs FX rounding and small fee drift. */
const SUBSCRIPTION_AMOUNT_DRIFT_PCT = 0.05;
const SUBSCRIPTION_AMOUNT_DRIFT_ABS = 2;

/** Max coefficient of variation (stddev / mean) of the inter-charge gaps for a
 *  merchant to count as "regular" in Tier B. */
const SUBSCRIPTION_GAP_CV_MAX = 0.25;

/** A charge is LAPSED once no new charge has landed within this multiple of its
 *  cadence (e.g. MONTHLY with no charge in ~45 days). */
const SUBSCRIPTION_LAPSE_MULTIPLIER = 1.5;

/** Cooldown (minutes) between user-initiated "Scan now" runs per tenant. */
const SUBSCRIPTION_REFRESH_COOLDOWN_MIN = 30;

/** How many recent contributing Transaction ids to store per RecurringCharge row
 *  (powers the "expand row → underlying charges" view). */
const SUBSCRIPTION_MAX_CONTRIBUTING_IDS = 24;

/** Median inter-charge gap (in days) → cadence bucket. A gap outside every bucket
 *  disqualifies a Tier-B candidate; Tier A falls back to MONTHLY. */
const SUBSCRIPTION_CADENCE_BUCKETS = {
    WEEKLY:    [5, 10],
    MONTHLY:   [24, 38],
    QUARTERLY: [78, 102],
    ANNUAL:    [330, 400],
};

/** Minimum occurrences before a single merchant is split into per-amount rows.
 *  Below this a merchant is always one row (its amount = median). At/above it,
 *  aggregator merchants (Apple App Store, Amazon, PayPal) whose charges fall
 *  into clearly separated amount bands become one RecurringCharge per band, so
 *  "Apple €2.99 / €9.99 / €22.00" stop collapsing into one misleading row.
 *  A band still needs >= 2 occurrences (Tier A) / MIN_OCCURRENCES (Tier B) to
 *  qualify, so a lone large purchase in the mix never becomes a subscription. */
const SUBSCRIPTION_CLUSTER_MIN_GROUP = 6;

module.exports = {
    EXACT_MATCH_CONFIDENCE,
    GLOBAL_VECTOR_DISCOUNT,
    EMBEDDING_DIMENSIONS,
    DEFAULT_PLAID_HISTORY_DAYS,
    DEFAULT_AUTO_PROMOTE_THRESHOLD,
    DEFAULT_REVIEW_THRESHOLD,
    TOP_N_SEEDS,
    PHASE2_CONCURRENCY,
    SUBSCRIPTION_INCREMENTAL_MONTHS,
    SUBSCRIPTION_FULL_SCAN_MONTHS,
    SUBSCRIPTION_TIER_B_ROW_CAP,
    SUBSCRIPTION_MIN_OCCURRENCES,
    SUBSCRIPTION_AMOUNT_DRIFT_PCT,
    SUBSCRIPTION_AMOUNT_DRIFT_ABS,
    SUBSCRIPTION_GAP_CV_MAX,
    SUBSCRIPTION_LAPSE_MULTIPLIER,
    SUBSCRIPTION_REFRESH_COOLDOWN_MIN,
    SUBSCRIPTION_MAX_CONTRIBUTING_IDS,
    SUBSCRIPTION_CADENCE_BUCKETS,
    SUBSCRIPTION_CLUSTER_MIN_GROUP,
};
