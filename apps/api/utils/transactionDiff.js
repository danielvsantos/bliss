/**
 * No-op detection for PUT /api/transactions (#141).
 *
 * `diffTransactionUpdate(existing, next, { tagIds })` returns the names of the
 * fields an update would actually change. `next` is the exact `data` object
 * the route hands to `prisma.transaction.update` (minus relations), so the
 * field list cannot drift from what is written. Keys whose value is
 * `undefined` are skipped, as Prisma skips them. `tagIds` is the resolved tag
 * set, or `undefined` when the request did not send `tags`.
 *
 * Normalisation errs toward "changed": a false "unchanged" would suppress an
 * event the backend needs, while a false "changed" only costs a refresh.
 */

// Optional free-text columns where null, undefined and '' mean the same thing.
const OPTIONAL_STRINGS = new Set(['details', 'ticker', 'isin', 'exchange', 'assetCurrency']);
// Decimal(18,8) columns. Compared at the column's own precision.
const DECIMALS = new Set(['credit', 'debit', 'assetQuantity', 'assetPrice']);
// Audit only: who saved last is not a change to the transaction.
const IGNORED = new Set(['userId']);

function decimalKey(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v?.toString?.() ?? v);
  return Number.isFinite(n) ? n.toFixed(8) : String(v);
}

function sameValue(field, before, after) {
  if (after instanceof Date || before instanceof Date) {
    const a = before ? new Date(before).getTime() : null;
    const b = after ? new Date(after).getTime() : null;
    return a === b;
  }
  if (DECIMALS.has(field)) return decimalKey(before) === decimalKey(after);
  if (OPTIONAL_STRINGS.has(field)) return (before || null) === (after || null);
  if (before === null || before === undefined || after === null) return (before ?? null) === after;
  return before === after;
}

/**
 * @param {Record<string, unknown> & { tags?: Array<{ tagId: number }> }} existing
 *   The row before the edit, with `tags: [{ tagId }]`.
 * @param {Record<string, unknown>} next  The update `data` (scalars only).
 * @param {{ tagIds?: number[] }} [options]
 * @returns {string[]} Changed field names (`'tags'` included); empty for a no-op.
 */
export function diffTransactionUpdate(existing, next, { tagIds } = {}) {
  const changed = [];
  for (const [field, after] of Object.entries(next)) {
    if (after === undefined || IGNORED.has(field)) continue;
    if (!sameValue(field, existing[field], after)) changed.push(field);
  }
  if (tagIds !== undefined) {
    const before = new Set((existing.tags || []).map((t) => t.tagId));
    const after = new Set(tagIds);
    if (before.size !== after.size || [...after].some((id) => !before.has(id))) changed.push('tags');
  }
  return changed;
}
