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
 * LLM                  | Gemini-assigned | 0.00–0.85  (hard-capped in geminiService)
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
const TOP_N_SEEDS = 15;

/** Maximum concurrent LLM calls during Phase 2 classification.
 *  Kept low (5) to avoid bursting into Gemini's per-minute quota.
 *  Gemini Flash paid tier: ~2000 RPM; free tier: 15 RPM.
 *  5 concurrent × ~3s/call ≈ 100 RPM — safe headroom on paid, paced on free. */
const PHASE2_CONCURRENCY = 5;

module.exports = {
    EXACT_MATCH_CONFIDENCE,
    GLOBAL_VECTOR_DISCOUNT,
    EMBEDDING_DIMENSIONS,
    DEFAULT_PLAID_HISTORY_DAYS,
    DEFAULT_AUTO_PROMOTE_THRESHOLD,
    DEFAULT_REVIEW_THRESHOLD,
    TOP_N_SEEDS,
    PHASE2_CONCURRENCY,
};
