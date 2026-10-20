/**
 * eToro Public API client (#143), shared by apps/api (connect check) and
 * apps/backend (sync). Node only. Read-only: it never sends a write request.
 *
 * Auth is the user's own key pair on every call (`x-api-key` + `x-user-key`)
 * plus a fresh `x-request-id`. Keys are never logged and never appear in an
 * error message.
 *
 * Pacing: eToro allows 60 reads/min per key and returns `RateLimit-Limit`,
 * `RateLimit-Remaining`, `RateLimit-Reset` (verified live). When one request
 * is left, the client waits for the reset; on a 429 it waits `Retry-After`
 * and retries once. A Bliss sync makes about four calls per connection, so
 * no shared budget is needed.
 *
 * See docs/specs/backend/25-etoro-copy-trading.md.
 */

import { randomUUID } from 'node:crypto';

export const DEFAULT_BASE_URL = 'https://public-api.etoro.com';
export const REQUEST_TIMEOUT_MS = 8_000;
/** Instrument ids per metadata request. */
export const INSTRUMENT_BATCH_SIZE = 50;
/** Longest wait the pacer accepts before giving up with RATE_LIMITED. */
export const MAX_WAIT_MS = 65_000;

export const ETORO_PATHS = Object.freeze({
  me: '/api/v1/me',
  aggregatePortfolio: '/api/v1/trading/info/aggregate-portfolio',
  portfolio: '/api/v1/trading/info/portfolio',
  instruments: '/api/v1/market-data/instruments',
});

/**
 * Error codes:
 *   KEY_INVALID     401/403: the key is wrong, expired, revoked or lacks the scope
 *   RATE_LIMITED    429 after one retry, or a reset too far away
 *   UNAVAILABLE     5xx, network error or timeout (retryable)
 *   SHAPE_CHANGED   a 2xx response without the fields Bliss relies on
 *   HTTP_ERROR      any other status
 */
export class EtoroError extends Error {
  constructor(code, message, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'EtoroError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }

  get retryable() {
    return this.code === 'UNAVAILABLE' || this.code === 'RATE_LIMITED';
  }
}

export function isKeyInvalid(err) {
  return err instanceof EtoroError && err.code === 'KEY_INVALID';
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** Seconds (delta or epoch) or an HTTP date → ms to wait from `nowMs`. */
export function parseWaitMs(value, nowMs = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const n = toNumber(value);
  if (n != null) {
    if (n > 1e9) return Math.max(0, n * 1000 - nowMs); // epoch seconds
    return Math.max(0, n * 1000);
  }
  const date = Date.parse(String(value));
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : null;
}

/**
 * @param {Object} opts
 * @param {string} opts.apiKey   eToro public API key (x-api-key)
 * @param {string} opts.userKey  eToro user key (x-user-key)
 * @param {string} [opts.baseUrl]
 * @param {Function} [opts.fetchImpl]   defaults to global fetch
 * @param {Function} [opts.sleep]       (ms) => Promise, for tests
 * @param {Function} [opts.now]         () => epoch ms, for tests
 * @param {number} [opts.timeoutMs]
 */
export function createEtoroClient({
  apiKey,
  userKey,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  now = Date.now,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (!apiKey || !userKey) throw new Error('eToro API key and user key are required');

  // Pacer state from the last response's RateLimit-* headers.
  let remaining = null;
  let resetAt = null;

  async function waitFor(ms) {
    if (!(ms > 0)) return;
    if (ms > MAX_WAIT_MS) {
      throw new EtoroError('RATE_LIMITED', 'eToro rate limit: reset too far away', { status: 429, retryAfterMs: ms });
    }
    await sleep(ms);
  }

  function readRateHeaders(res) {
    const h = res.headers;
    const rem = toNumber(h?.get?.('ratelimit-remaining'));
    const reset = parseWaitMs(h?.get?.('ratelimit-reset'), now());
    if (rem != null) remaining = rem;
    if (reset != null) resetAt = now() + reset;
  }

  async function send(method, path, { query, body } = {}) {
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      return await fetchImpl(url.toString(), {
        method,
        headers: {
          'x-api-key': apiKey,
          'x-user-key': userKey,
          'x-request-id': randomUUID(),
          accept: 'application/json',
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        ...(controller && { signal: controller.signal }),
      });
    } catch (err) {
      const reason = err?.name === 'AbortError' ? 'timeout' : (err?.cause?.code || 'network error');
      throw new EtoroError('UNAVAILABLE', `eToro request failed (${reason})`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function request(method, path, opts = {}) {
    if (remaining != null && remaining <= 1 && resetAt != null) {
      await waitFor(resetAt - now());
      remaining = null;
    }

    let res = await send(method, path, opts);
    readRateHeaders(res);
    if (res.status === 429) {
      const wait = parseWaitMs(res.headers?.get?.('retry-after'), now())
        ?? (resetAt != null ? resetAt - now() : 1000);
      await waitFor(wait);
      res = await send(method, path, opts);
      readRateHeaders(res);
      if (res.status === 429) {
        throw new EtoroError('RATE_LIMITED', 'eToro rate limit reached', {
          status: 429,
          retryAfterMs: parseWaitMs(res.headers?.get?.('retry-after'), now()),
        });
      }
    }

    if (res.status === 401 || res.status === 403) {
      throw new EtoroError('KEY_INVALID', `eToro refused the key (HTTP ${res.status})`, { status: res.status });
    }
    if (res.status >= 500) {
      throw new EtoroError('UNAVAILABLE', `eToro is unavailable (HTTP ${res.status})`, { status: res.status });
    }
    if (!res.ok) {
      throw new EtoroError('HTTP_ERROR', `eToro request failed (HTTP ${res.status})`, { status: res.status });
    }
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new EtoroError('SHAPE_CHANGED', 'eToro returned a non-JSON response', { status: res.status });
    }
  }

  return {
    /** `{ cid, username, scopes }` of the key's eToro login. */
    async getMe() {
      return parseMe(await request('GET', ETORO_PATHS.me));
    },
    /** Account value per copy, with per-instrument detail. */
    async getAggregatePortfolio() {
      return request('POST', ETORO_PATHS.aggregatePortfolio, {
        body: { mirrorLevel: 'details', instrumentLevel: 'details' },
      });
    },
    /** Raw portfolio: copy metadata (copied investor, start date). */
    async getPortfolio() {
      return request('GET', ETORO_PATHS.portfolio);
    },
    /** Instrument metadata by id, in batches. Returns `Map<instrumentId, metadata>`. */
    async getInstruments(ids = []) {
      const unique = [...new Set(ids.map(Number).filter(Number.isFinite))];
      const out = new Map();
      for (let i = 0; i < unique.length; i += INSTRUMENT_BATCH_SIZE) {
        const chunk = unique.slice(i, i + INSTRUMENT_BATCH_SIZE);
        const body = await request('GET', ETORO_PATHS.instruments, { query: { instrumentIds: chunk.join(',') } });
        for (const d of body?.instrumentDisplayDatas || []) {
          const id = Number(d?.instrumentID ?? d?.instrumentId);
          if (Number.isFinite(id)) out.set(id, d);
        }
      }
      return out;
    },
  };
}

const pick = (o, ...keys) => {
  for (const k of keys) if (o?.[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
};

/**
 * Parse `GET /api/v1/me`. The real-account customer id is the connection's
 * stable identity.
 */
export function parseMe(me) {
  if (!me || typeof me !== 'object') throw new EtoroError('SHAPE_CHANGED', 'eToro /me returned no body');
  const cid = pick(me, 'realCid', 'realCID', 'gcid', 'cid');
  if (cid === undefined) throw new EtoroError('SHAPE_CHANGED', 'eToro /me has no customer id');
  const username = pick(me, 'username', 'userName', 'nickname') ?? null;
  return {
    cid: String(cid),
    username: username == null ? null : String(username),
    scopes: Array.isArray(me.scopes) ? me.scopes.filter((s) => typeof s === 'string') : [],
  };
}

/**
 * Join the aggregate portfolio (values + per-instrument detail) with the raw
 * portfolio (who is copied, since when) into one list of copies. Mirror id 0
 * (the user's direct holdings) is ignored.
 *
 * @returns {{ currency: string, copies: Array<{ mirrorId: string, parentUsername: string, parentCid: string|null,
 *            startedAt: Date|null, value: number, cash: number, instruments: Array<{ instrumentId: number, value: number }> }> }}
 * @throws {EtoroError} SHAPE_CHANGED when the aggregate response has no mirror list
 */
export function parseCopies(aggregate, portfolio = null) {
  if (!aggregate || typeof aggregate !== 'object' || !Array.isArray(aggregate.mirrors)) {
    throw new EtoroError('SHAPE_CHANGED', 'eToro aggregate portfolio has no mirrors');
  }
  const meta = new Map();
  for (const m of portfolio?.clientPortfolio?.mirrors || []) {
    const id = pick(m, 'mirrorID', 'mirrorId');
    if (id !== undefined) meta.set(String(id), m);
  }

  const copies = [];
  for (const m of aggregate.mirrors) {
    const mirrorId = pick(m, 'mirrorId', 'mirrorID');
    if (mirrorId === undefined || Number(mirrorId) === 0) continue;
    const info = meta.get(String(mirrorId)) || {};
    const username = pick(m, 'parentUsername', 'parentUserName') ?? pick(info, 'parentUsername', 'parentUserName');
    if (!username) throw new EtoroError('SHAPE_CHANGED', 'eToro copy without a copied investor');
    const value = toNumber(m?.mirrorTotals?.mirrorLiquidationValue ?? m?.mirrorLiquidationValue);
    if (value == null) throw new EtoroError('SHAPE_CHANGED', 'eToro copy without a value');
    const started = pick(m, 'startedCopyDate') ?? pick(info, 'startedCopyDate');
    const startedAt = started ? new Date(started) : null;
    const parentCid = pick(m, 'parentCID', 'parentCid') ?? pick(info, 'parentCID', 'parentCid');
    copies.push({
      mirrorId: String(mirrorId),
      parentUsername: String(username).trim().toLowerCase(),
      parentCid: parentCid == null ? null : String(parentCid),
      startedAt: startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt : null,
      value,
      cash: Math.max(toNumber(m?.mirrorAvailableCash) ?? 0, 0),
      instruments: (Array.isArray(m.instrumentAggregates) ? m.instrumentAggregates : [])
        .map((a) => ({
          instrumentId: Number(pick(a, 'instrumentId', 'instrumentID')),
          value: toNumber(a?.liquidationValueAccountCurrency) ?? 0,
        }))
        .filter((a) => Number.isFinite(a.instrumentId)),
    });
  }
  return { currency: String(aggregate.accountCurrency || 'USD').toUpperCase(), copies };
}
