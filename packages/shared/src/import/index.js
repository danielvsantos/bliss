/**
 * @bliss/shared/import — the Smart Import hold-back contract (#142).
 *
 * When a commit leaves a CONFIRMED row uncommitted, the backend commitWorker
 * (CJS) writes the reason to `StagedImportRow.errorMessage` as a stable,
 * machine-readable string so the API (filter), the MCP tools and the web app
 * (translated badge) can all read it:
 *
 *   HELD_BACK:<CODE>[,<CODE>…]      e.g. "HELD_BACK:MISSING_QUANTITY,MISSING_PRICE"
 *
 * The prefix keeps the codes apart from the free-text staging messages that
 * live in the same column ("Missing or invalid date", …); those never parse.
 * The web bundle doesn't depend on @bliss/shared and mirrors parseHoldBack()
 * in apps/web/src/lib/import-hold-back.ts — keep the two in sync.
 */

export const HOLD_BACK_PREFIX = 'HELD_BACK:';

/** Canonical order: investment fields first, then account, then the rest. */
export const HOLD_BACK_REASONS = Object.freeze([
    'MISSING_TICKER',
    'MISSING_QUANTITY',
    'MISSING_PRICE',
    'MISSING_ACCOUNT',
    'DUPLICATE',
    'UPDATE_FAILED',
    'COMMIT_ERROR',
]);

/** missingInvestmentFields() field → reason code. */
export const FIELD_HOLD_BACK_REASONS = Object.freeze({
    ticker: 'MISSING_TICKER',
    quantity: 'MISSING_QUANTITY',
    price: 'MISSING_PRICE',
});

/**
 * Build the errorMessage for a held-back row. De-dupes and sorts into the
 * canonical order; throws on an unknown code (a programming error).
 */
export function formatHoldBack(codes) {
    const set = new Set(codes);
    for (const c of set) {
        if (!HOLD_BACK_REASONS.includes(c)) throw new Error(`Unknown hold-back reason: ${c}`);
    }
    if (set.size === 0) throw new Error('formatHoldBack() needs at least one reason');
    return HOLD_BACK_PREFIX + HOLD_BACK_REASONS.filter((c) => set.has(c)).join(',');
}

/**
 * Reason codes carried by an errorMessage, or null when it is not a hold-back
 * reason (null, staging text, …). Unknown codes are dropped (forward-compatible).
 */
export function parseHoldBack(errorMessage) {
    if (typeof errorMessage !== 'string' || !errorMessage.startsWith(HOLD_BACK_PREFIX)) return null;
    const codes = errorMessage.slice(HOLD_BACK_PREFIX.length).split(',')
        .filter((c) => HOLD_BACK_REASONS.includes(c));
    return codes.length > 0 ? codes : null;
}

/**
 * Tally held-back rows into the `commitResult.heldBack` shape:
 * `{ total, byReason }`. `total` counts rows; `byReason` counts codes, so a row
 * missing quantity and price adds 1 to total and 1 to each code. Keys only
 * appear when > 0, in canonical order.
 *
 * @param {Iterable<string[]>} codeLists one code list per held-back row
 */
export function summarizeHeldBack(codeLists) {
    let total = 0;
    const counts = new Map();
    for (const codes of codeLists) {
        if (!codes || codes.length === 0) continue;
        total++;
        for (const c of new Set(codes)) counts.set(c, (counts.get(c) || 0) + 1);
    }
    const byReason = {};
    for (const c of HOLD_BACK_REASONS) if (counts.has(c)) byReason[c] = counts.get(c);
    return { total, byReason };
}
