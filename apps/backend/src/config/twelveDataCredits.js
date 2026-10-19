/**
 * Twelve Data credit budget (#150) — single source of truth for what each
 * endpoint costs, the priority classes, and the per-minute limit.
 *
 * Every Twelve Data request reserves its endpoint's cost from one sliding
 * one-minute window shared by all backend processes (`utils/twelveDataBudget.js`).
 * Reservations are never corrected after the call: Twelve Data's
 * `api-credits-used` header is the key's running total for the current minute
 * (`used + left = plan limit`), not the cost of one call. Keep these costs at or
 * above Twelve Data's published weights.
 */

const logger = require('../utils/logger');

/** Lower number = served first. A waiter blocks every strictly lower priority. */
const PRIORITIES = Object.freeze({
    INTERACTIVE: 1,   // ticker search/profile, pricing route, smart import
    VALUATION: 2,     // portfolio valuation, FX for analytics/insights
    FUNDAMENTALS: 3,  // nightly security master refresh
    BACKGROUND: 4,    // bulk/admin refreshes, #143 watchlist
});

const PRIORITY_NAMES = Object.freeze(
    Object.fromEntries(Object.entries(PRIORITIES).map(([name, value]) => [value, name])),
);

/** A Twelve Data call made outside any priority context runs at this priority. */
const DEFAULT_PRIORITY = PRIORITIES.VALUATION;

/** Endpoints without a confirmed weight are reserved conservatively. */
const UNKNOWN_ENDPOINT_COST = 20;

/** Credits per call, keyed by the endpoint path (no leading slash). */
const CREDIT_COSTS = Object.freeze({
    time_series: 1,
    quote: 1,
    exchange_rate: 1,
    symbol_search: 1,
    profile: 10,
    earnings: 20,
    dividends: 20,
    'etfs/world/composition': UNKNOWN_ENDPOINT_COST,
});

/** Twelve Data Grow plan. Lower it to your plan's limit (8 on the free plan). */
const DEFAULT_CREDITS_PER_MINUTE = 377;

/** Per-process share of the limit while the shared Redis store is unreachable. */
const FALLBACK_SHARE = 0.25;

const WINDOW_MS = 60_000;
/** A waiter whose heartbeat is older than this no longer blocks lower priorities. */
const WAITER_TTL_MS = 3_000;
/** Longest single sleep between acquire attempts (keeps the heartbeat fresh). */
const POLL_CAP_MS = 1_000;

function creditCost(endpoint) {
    return Object.prototype.hasOwnProperty.call(CREDIT_COSTS, endpoint)
        ? CREDIT_COSTS[endpoint]
        : UNKNOWN_ENDPOINT_COST;
}

/** Parses `TWELVE_DATA_CREDITS_PER_MINUTE`; null when unset, NaN when invalid. */
function parseCreditsPerMinute(raw) {
    if (raw == null || String(raw).trim() === '') return null;
    const value = Number(String(raw).trim());
    return Number.isInteger(value) && value > 0 ? value : NaN;
}

let warnedInvalid = false;

/** The effective limit. An invalid value warns once and falls back to the default. */
function getCreditsPerMinute() {
    const parsed = parseCreditsPerMinute(process.env.TWELVE_DATA_CREDITS_PER_MINUTE);
    if (parsed === null) return DEFAULT_CREDITS_PER_MINUTE;
    if (Number.isNaN(parsed)) {
        if (!warnedInvalid) {
            warnedInvalid = true;
            logger.warn('[TwelveData] Invalid TWELVE_DATA_CREDITS_PER_MINUTE, using the default', {
                value: process.env.TWELVE_DATA_CREDITS_PER_MINUTE,
                default: DEFAULT_CREDITS_PER_MINUTE,
            });
        }
        return DEFAULT_CREDITS_PER_MINUTE;
    }
    return parsed;
}

module.exports = {
    PRIORITIES,
    PRIORITY_NAMES,
    DEFAULT_PRIORITY,
    DEFAULT_CREDITS_PER_MINUTE,
    FALLBACK_SHARE,
    WINDOW_MS,
    WAITER_TTL_MS,
    POLL_CAP_MS,
    creditCost,
    parseCreditsPerMinute,
    getCreditsPerMinute,
};
