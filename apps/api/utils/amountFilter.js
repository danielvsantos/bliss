/**
 * Amount range filter for GET /api/transactions (#141).
 *
 * `amountMin` / `amountMax` are unsigned magnitudes in the transaction's own
 * currency, both inclusive, compared at 2-decimal precision against whichever
 * of `credit` / `debit` is set (amounts are stored unsigned). An exact amount
 * is `amountMin = amountMax`. Values are rounded half-up to cents and widened
 * by half a cent, so a stored `2003.76000000` (or an FX-derived `2003.7649`)
 * matches `2003.76`.
 */

const HALF_CENT = 0.005;

function parseBound(raw, name) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  const text = String(Array.isArray(raw) ? raw[0] : raw).trim();
  // Number('') and Number('0x10') would both pass isFinite; insist on a decimal.
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return { error: `${name} must be a non-negative number.` };
  }
  const n = Number(text);
  if (!Number.isFinite(n)) return { error: `${name} must be a non-negative number.` };
  // Half-up to cents; the epsilon absorbs binary noise (2003.765 → 2003.77).
  return { value: Math.round((n + Number.EPSILON) * 100) / 100 };
}

/**
 * @param {{ amountMin?: unknown, amountMax?: unknown }} query
 * @returns {{ error: string } | { where: object|null, amountMin: number|null, amountMax: number|null }}
 *   `where` is a Prisma clause to AND into the transaction filter, or null when
 *   neither bound is set.
 */
export function parseAmountRange({ amountMin, amountMax } = {}) {
  const min = parseBound(amountMin, 'amountMin');
  if (min.error) return { error: min.error };
  const max = parseBound(amountMax, 'amountMax');
  if (max.error) return { error: max.error };

  if (min.value === null && max.value === null) {
    return { where: null, amountMin: null, amountMax: null };
  }
  if (min.value !== null && max.value !== null && min.value > max.value) {
    return { error: 'amountMin cannot be greater than amountMax.' };
  }

  const range = {
    ...(min.value !== null && { gte: Math.max(min.value - HALF_CENT, 0) }),
    ...(max.value !== null && { lt: max.value + HALF_CENT }),
  };
  return {
    where: { OR: [{ credit: range }, { debit: range }] },
    amountMin: min.value,
    amountMax: max.value,
  };
}
