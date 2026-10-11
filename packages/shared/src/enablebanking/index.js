/**
 * Enable Banking (PSD2 AIS) client, shared by apps/api (ESM) and
 * apps/backend (CJS) through the dual tsup build (#132).
 *
 * Node only — the web app never imports this module. Secrets (the RSA private
 * key and the signed JWT) are never logged and never appear in error messages.
 *
 * See docs/specs/backend/24-enable-banking.md.
 */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const DEFAULT_BASE_URL = 'https://api.enablebanking.com';
export const JWT_TTL_SECONDS = 3600;
const JWT_REFRESH_MARGIN_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 20_000;

const base64url = (input) => Buffer.from(input).toString('base64url');

/**
 * Signs the RS256 application JWT Enable Banking expects on every call.
 *
 * @param {{ appId: string, privateKeyPem: string, now?: number }} opts
 *   `now` is seconds since the epoch (tests pass a fixed value).
 * @returns {string}
 */
export function signJwt({ appId, privateKeyPem, now }) {
  if (!appId) throw new Error('Enable Banking app id is required');
  if (!privateKeyPem) throw new Error('Enable Banking private key is required');
  const iat = Math.floor(now ?? Date.now() / 1000);
  const header = { typ: 'JWT', alg: 'RS256', kid: appId };
  const claims = {
    iss: 'enablebanking.com',
    aud: 'api.enablebanking.com',
    iat,
    exp: iat + JWT_TTL_SECONDS,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKeyPem).toString('base64url');
  return `${signingInput}.${signature}`;
}

/**
 * Reads the private key from the environment: `ENABLE_BANKING_PRIVATE_KEY`
 * (PEM contents; `\n`-escaped newlines accepted, as most PaaS env editors are
 * single-line) or `ENABLE_BANKING_PRIVATE_KEY_PATH` (a file path).
 *
 * @returns {string | null} the PEM, or null when neither is set.
 */
export function loadPrivateKey(env = process.env) {
  const inline = env.ENABLE_BANKING_PRIVATE_KEY;
  if (inline && inline.trim()) {
    return inline.includes('\\n') ? inline.replace(/\\n/g, '\n') : inline;
  }
  const path = env.ENABLE_BANKING_PRIVATE_KEY_PATH;
  if (path && path.trim()) {
    return readFileSync(path.trim(), 'utf8');
  }
  return null;
}

/**
 * The feature's configuration state. `enabled` requires both the app id and a
 * key; `partial` flags a half-configured deployment so boot can warn.
 */
export function getEnableBankingConfig(env = process.env) {
  const appId = (env.ENABLE_BANKING_APP_ID || '').trim();
  const hasKey = Boolean(
    (env.ENABLE_BANKING_PRIVATE_KEY && env.ENABLE_BANKING_PRIVATE_KEY.trim())
    || (env.ENABLE_BANKING_PRIVATE_KEY_PATH && env.ENABLE_BANKING_PRIVATE_KEY_PATH.trim()),
  );
  return {
    enabled: Boolean(appId) && hasKey,
    partial: Boolean(appId) !== hasKey,
    appId: appId || null,
    baseUrl: (env.ENABLE_BANKING_API_URL || '').trim() || DEFAULT_BASE_URL,
  };
}

/** Error codes Enable Banking returns when a session can no longer be used. */
const CONSENT_ERROR_PATTERN = /EXPIRED|REVOKED|SESSION|CONSENT|UNAUTHORI[SZ]ED/i;

/**
 * Typed error for every non-2xx (or network) failure. `status` is the HTTP
 * status (0 for network / timeout), `code` the provider error code when the
 * body carries one, `retryable` whether a later attempt may succeed, and
 * `consent` whether the session is expired or revoked (reconnect required).
 */
export class EnableBankingError extends Error {
  constructor(message, { status = 0, code = null, retryable = false } = {}) {
    super(message);
    this.name = 'EnableBankingError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.rateLimited = status === 429;
    this.consent = status === 401 || status === 403
      || (status >= 400 && status < 500 && status !== 429 && Boolean(code) && CONSENT_ERROR_PATTERN.test(code));
  }
}

function errorFromResponse(method, path, status, body) {
  const code = typeof body?.error === 'string'
    ? body.error
    : (typeof body?.code === 'string' ? body.code : null);
  const retryable = status === 429 || status >= 500;
  // The path carries no secret (uids and session ids only); the message never
  // includes request headers, so the JWT cannot leak through logs or Sentry.
  return new EnableBankingError(
    `Enable Banking ${method} ${path} failed with ${status}${code ? ` (${code})` : ''}`,
    { status, code, retryable },
  );
}

/**
 * @param {{ appId: string, privateKey: string, baseUrl?: string, fetchImpl?: typeof fetch, timeoutMs?: number, nowFn?: () => number }} opts
 */
export function createClient({
  appId,
  privateKey,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  nowFn = () => Date.now(),
}) {
  if (!appId || !privateKey) throw new Error('Enable Banking client needs appId and privateKey');
  let cached = null; // { token, exp }

  function token() {
    const nowSec = Math.floor(nowFn() / 1000);
    if (!cached || cached.exp - JWT_REFRESH_MARGIN_SECONDS <= nowSec) {
      cached = { token: signJwt({ appId, privateKeyPem: privateKey, now: nowSec }), exp: nowSec + JWT_TTL_SECONDS };
    }
    return cached.token;
  }

  async function request(method, path, { query, body } = {}) {
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${token()}`,
          Accept: 'application/json',
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (err) {
      const timedOut = err?.name === 'AbortError';
      throw new EnableBankingError(
        `Enable Banking ${method} ${url.pathname} ${timedOut ? 'timed out' : 'network error'}`,
        { status: 0, code: timedOut ? 'TIMEOUT' : 'NETWORK', retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    if (!res.ok) throw errorFromResponse(method, url.pathname, res.status, json);
    return json ?? {};
  }

  return {
    /** GET /aspsps?country= → the bank list for one country. */
    getAspsps: async (country) => (await request('GET', '/aspsps', { query: { country, psu_type: 'personal' } })).aspsps || [],
    /** POST /auth → { url, authorization_id }. */
    startAuth: (body) => request('POST', '/auth', { body }),
    /** POST /sessions { code } → the session with its accounts (returned only once). */
    createSession: (code) => request('POST', '/sessions', { body: { code } }),
    getSession: (sessionId) => request('GET', `/sessions/${encodeURIComponent(sessionId)}`),
    deleteSession: (sessionId) => request('DELETE', `/sessions/${encodeURIComponent(sessionId)}`),
    /** One page of transactions; follow `continuation_key` until it is absent. */
    getTransactions: (uid, { dateFrom, continuationKey } = {}) => request(
      'GET',
      `/accounts/${encodeURIComponent(uid)}/transactions`,
      { query: { date_from: dateFrom, continuation_key: continuationKey } },
    ),
    getBalances: async (uid) => (await request('GET', `/accounts/${encodeURIComponent(uid)}/balances`)).balances || [],
  };
}

/**
 * The balance closest to "booked": CLBD › ITBD › XPCD › ITAV › first.
 * @returns {{ amount: string, currency: string, type: string } | null}
 */
export function pickBalance(balances) {
  if (!Array.isArray(balances) || balances.length === 0) return null;
  const order = ['CLBD', 'ITBD', 'XPCD', 'ITAV'];
  const sorted = [...balances].sort((a, b) => {
    const ia = order.indexOf(a?.balance_type);
    const ib = order.indexOf(b?.balance_type);
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
  });
  const pick = sorted[0];
  if (!pick?.balance_amount?.amount) return null;
  return {
    amount: String(pick.balance_amount.amount),
    currency: pick.balance_amount.currency || null,
    type: pick.balance_type || null,
  };
}

// ── Synthetic keys (D2) ────────────────────────────────────────────────────
// Account uids are session-scoped; identification_hash is stable across
// reconnects, so every key Bliss stores derives from it.

export const EB_ITEM_PREFIX = 'eb_';
export const ebAccountKey = (identificationHash) => `eb:${identificationHash}`;
export const ebTransactionKey = (identificationHash, entryReference) => `eb:${identificationHash}:${entryReference}`;
export const ebFingerprintKey = (identificationHash, fingerprint) => `eb:${identificationHash}:fp:${fingerprint}`;

// ── Date window (R8) ───────────────────────────────────────────────────────
// Same formula plaidSyncWorker applies to Plaid items, shared so the API can
// show the user the exact start date the worker will use.

const DAY_MS = 24 * 60 * 60 * 1000;
export const SYNC_OVERLAP_DAYS = 7;

function utcMidnight(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** UTC midnight of `createdAt` minus `historyDays` (negative / NaN treated as 0). */
export function syncCutoffDate(createdAt, historyDays) {
  const days = Number.isFinite(Number(historyDays)) && Number(historyDays) > 0 ? Math.floor(Number(historyDays)) : 0;
  const cutoff = utcMidnight(createdAt);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return cutoff;
}

/**
 * The `date_from` of a sync: the cutoff on the first sync, then
 * max(cutoff, UTC midnight of lastSync − 7 days) to catch late-booked items.
 */
export function syncDateFrom({ createdAt, historyDays, lastSync }) {
  const cutoff = syncCutoffDate(createdAt, historyDays);
  if (!lastSync) return cutoff;
  const overlap = new Date(utcMidnight(lastSync).getTime() - SYNC_OVERLAP_DAYS * DAY_MS);
  return overlap > cutoff ? overlap : cutoff;
}

export const isoDate = (date) => new Date(date).toISOString().slice(0, 10);

// ── Unattended-access budget (R12, decision D5) ────────────────────────────
// One Redis counter per bank account per Europe/Madrid day. One sync run of
// one account counts as one access, whatever the number of pages. The worker's
// INCR is the authority; the API only reads it before enqueueing.

export const BUDGET_TIMEZONE = 'Europe/Madrid';
export const DEFAULT_DAILY_BUDGET = 4;
export const BUDGET_KEY_TTL_SECONDS = 36 * 60 * 60;

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** `YYYY-MM-DD` of `date` in Europe/Madrid. */
export function budgetDay(date = new Date()) {
  const p = zonedParts(date, BUDGET_TIMEZONE);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The instant the current Madrid day ends (when a spent budget resets). */
export function budgetResetsAt(now = new Date()) {
  const p = zonedParts(now, BUDGET_TIMEZONE);
  // Offset of Madrid from UTC at `now`, in ms (CET +1h / CEST +2h).
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offset = asUtc - Math.floor(now.getTime() / 1000) * 1000;
  let reset = new Date(Date.UTC(p.year, p.month - 1, p.day + 1) - offset);
  // A DST switch at the boundary shifts the offset by an hour; re-anchor once.
  const check = zonedParts(reset, BUDGET_TIMEZONE);
  if (check.hour !== 0) reset = new Date(reset.getTime() - (check.hour > 12 ? check.hour - 24 : check.hour) * 3600_000);
  return reset;
}

export const budgetKey = (ebAccountId, day) => `ebbudget:v1:${ebAccountId}:${day}`;

export function getDailyBudget(env = process.env) {
  const n = parseInt(env.ENABLE_BANKING_DAILY_BUDGET ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_BUDGET;
}

/** Scheduled sync slots (Madrid HH:MM). Default 3/day so a manual "Sync now" fits the budget of 4. */
export const DEFAULT_SYNC_TIMES = ['06:15', '13:15', '20:15'];

export function getSyncTimes(env = process.env) {
  const raw = (env.ENABLE_BANKING_SYNC_TIMES || '').trim();
  if (!raw) return DEFAULT_SYNC_TIMES;
  const times = raw.split(',').map((t) => t.trim()).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
  return times.length > 0 ? [...new Set(times)] : DEFAULT_SYNC_TIMES;
}
