import { ToolInputError } from './errors.js';

/**
 * Response shaping for MCP tools (#89): opaque cursors, bounded pages,
 * `{ value, currency }` money, ISO dates, and a size backstop. Every list a
 * tool returns goes through `pageArgs`/`paginate`, so no single response grows
 * with the size of a tenant's data.
 */

const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
/** Target size of a default page (asserted in tests). */
export const TARGET_RESPONSE_CHARS = 25_000;
/** Hard cap enforced by capResponse (a max-limit page of wide rows still fits). */
export const MAX_RESPONSE_CHARS = 50_000;

/**
 * Keys never shown to an agent: hashes, raw provider payloads, embeddings,
 * full account numbers (#98: tools show `accountNumberLast4` only).
 */
const OMIT_KEYS = Object.freeze([
  'rawJson', 'rawData', 'embedding', 'hash', 'keyHash', 'accessToken', 'dedupeHash',
  'transactionHash', 'plaidTransactionId', 'externalId', 'accountNumber',
]);

export function encodeCursor(state) {
  return Buffer.from(JSON.stringify(state)).toString('base64url');
}

/** @returns {Record<string, number>} the decoded state, or `{}` for no cursor. */
export function decodeCursor(cursor) {
  if (cursor == null || cursor === '') return {};
  try {
    const state = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (state && typeof state === 'object' && !Array.isArray(state)
      && Object.values(state).every((v) => Number.isInteger(v) && v >= 0)) {
      return state;
    }
  } catch {
    // fall through
  }
  throw new ToolInputError('Invalid cursor. Pass the nextCursor value from the previous result unchanged.');
}

export function clampLimit(limit, fallback = DEFAULT_LIMIT) {
  const n = Number.isInteger(limit) ? limit : fallback;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

/** For REST routes paged by `page` (1-based): `{ page, limit }`. */
export function pageArgs({ cursor, limit }, fallback) {
  const { page = 1 } = decodeCursor(cursor);
  return { page: Math.max(page, 1), limit: clampLimit(limit, fallback) };
}

/** `{ hasMore, nextCursor }` for a page-based REST result. */
export function pageMeta({ page, limit }, total) {
  const hasMore = page * limit < total;
  return { hasMore, nextCursor: hasMore ? encodeCursor({ page: page + 1 }) : null };
}

/** For REST routes paged by `offset`: `{ offset, limit }`. */
export function offsetArgs({ cursor, limit }, fallback) {
  const { offset = 0 } = decodeCursor(cursor);
  return { offset, limit: clampLimit(limit, fallback) };
}

export function offsetMeta({ offset, limit }, total) {
  const hasMore = offset + limit < total;
  return { hasMore, nextCursor: hasMore ? encodeCursor({ offset: offset + limit }) : null };
}

/** Slice an in-memory list (routes without pagination). */
export function paginate(items, { cursor, limit }, fallback) {
  const args = offsetArgs({ cursor, limit }, fallback);
  const list = Array.isArray(items) ? items : [];
  return {
    items: list.slice(args.offset, args.offset + args.limit),
    total: list.length,
    ...offsetMeta(args, list.length),
  };
}

/** Decimal / string / number → number (null when absent or not finite). */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(typeof v === 'object' ? v.toString() : v);
  return Number.isFinite(n) ? n : null;
}

export function money(value, currency) {
  const n = num(value);
  return n === null ? null : { value: Math.round(n * 100) / 100, currency: currency || null };
}

/** Signed amount: credit (money in) positive, debit (money out) negative. */
export function signedAmount({ credit, debit }) {
  const c = num(credit);
  const d = num(debit);
  if (c) return c;
  if (d) return -d;
  return 0;
}

/** Any date-ish value → `YYYY-MM-DD` (null when absent/invalid). */
export function isoDate(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}


/** Recursively drop OMIT_KEYS. */
export function omitDeep(value, keys = OMIT_KEYS) {
  if (Array.isArray(value)) return value.map((v) => omitDeep(v, keys));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (keys.includes(k)) continue;
      out[k] = omitDeep(v, keys);
    }
    return out;
  }
  return value;
}

function largestArrayPath(obj, path = []) {
  let best = null;
  if (Array.isArray(obj)) {
    best = { path, length: obj.length };
    obj.forEach((v, i) => {
      const inner = largestArrayPath(v, [...path, i]);
      if (inner && inner.length > best.length) best = inner;
    });
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const inner = largestArrayPath(v, [...path, k]);
      if (inner && (!best || inner.length > best.length)) best = inner;
    }
  }
  return best;
}

/**
 * Size backstop: trim the longest list until the JSON fits MAX_RESPONSE_CHARS
 * and flag the result. Tools already page their output (default pages stay
 * under TARGET_RESPONSE_CHARS); this only fires on unusually wide rows. A
 * trimmed page drops `nextCursor`, so an agent is never led past rows it did
 * not receive: it is told to retry with a smaller limit instead.
 */
export function capResponse(result, maxChars = MAX_RESPONSE_CHARS) {
  if (JSON.stringify(result).length <= maxChars) return result;
  const out = structuredClone(result);
  for (let guard = 0; guard < 1000 && JSON.stringify(out).length > maxChars; guard += 1) {
    const target = largestArrayPath(out);
    if (!target || target.length === 0) break;
    let parent = out;
    for (const key of target.path.slice(0, -1)) parent = parent[key];
    const last = target.path[target.path.length - 1];
    const arr = target.path.length === 0 ? out : parent[last];
    arr.length = Math.floor(arr.length * 0.75);
  }
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    out.truncated = true;
    if ('nextCursor' in out) out.nextCursor = null;
    out.truncationHint = 'The result was too large and a list was shortened. Retry with a smaller limit (and page with nextCursor) or narrower filters.';
  }
  return out;
}
