/**
 * Enable Banking (PSD2 AIS) client, shared by apps/api (ESM) and
 * apps/backend (CJS) through the dual tsup build (#132).
 *
 * Node only — the web app never imports this module. Secrets (the RSA private
 * key and the signed JWT) are never logged and never appear in error messages.
 *
 * See docs/specs/backend/24-enable-banking.md.
 */

import { createHash, createPrivateKey, createPublicKey, createSign } from 'node:crypto';

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

// ── Deployment configuration ───────────────────────────────────────────────
// The Enable Banking app itself is per tenant (#148): its id and key live
// encrypted in EnableBankingCredential. Only the API base URL stays
// deployment-wide.

export function getBaseUrl(env = process.env) {
  return (env.ENABLE_BANKING_API_URL || '').trim() || DEFAULT_BASE_URL;
}

/** Env vars of the retired deployment-level app (#148), so boot can warn. */
export const RETIRED_ENV_VARS = ['ENABLE_BANKING_APP_ID', 'ENABLE_BANKING_PRIVATE_KEY', 'ENABLE_BANKING_PRIVATE_KEY_PATH'];

/** The retired env vars that are still set (non-empty). */
export function retiredEnvVars(env = process.env) {
  return RETIRED_ENV_VARS.filter((name) => typeof env[name] === 'string' && env[name].trim() !== '');
}

// ── Private key parsing (#148, R1a) ────────────────────────────────────────
// The server is the authority; apps/web/src/lib/pem.ts mirrors the format
// checks for instant feedback. Both are tested against the same fixtures in
// packages/shared/test-fixtures/enablebanking-keys/.

export const MAX_PRIVATE_KEY_BYTES = 16 * 1024;
export const MIN_RSA_BITS = 2048;

/**
 * Format error of a private key. `code` is one of KEY_NOT_PEM, KEY_PUBLIC,
 * KEY_CERTIFICATE, KEY_NOT_RSA, KEY_ENCRYPTED, KEY_TRUNCATED, KEY_TOO_LARGE,
 * KEY_TOO_SMALL. The message never contains key material.
 */
export class KeyFormatError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KeyFormatError';
    this.code = code;
  }
}

const PEM_BEGIN = /-----BEGIN ([A-Z0-9 ]+)-----/;

/**
 * Validates and normalises an RSA private key PEM: CRLF / CR line endings,
 * literal `\n` escapes (a key copied from a .env file), surrounding whitespace
 * and blank lines are accepted; PKCS#8 and PKCS#1 both load.
 *
 * @param {string} input
 * @returns {{ pem: string, bits: number, fingerprint: string }} `pem` is the
 *   re-exported PKCS#8 PEM (the stored form).
 * @throws {KeyFormatError}
 */
export function parsePrivateKey(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new KeyFormatError('KEY_NOT_PEM', 'The private key is empty');
  }
  if (Buffer.byteLength(input, 'utf8') > MAX_PRIVATE_KEY_BYTES) {
    throw new KeyFormatError('KEY_TOO_LARGE', 'The private key is larger than 16 KB');
  }
  const text = input.replace(/\\r\\n|\\n|\\r/g, '\n').replace(/\r\n?/g, '\n').trim();

  const begin = PEM_BEGIN.exec(text);
  if (!begin) throw new KeyFormatError('KEY_NOT_PEM', 'This is not a PEM private key');
  const label = begin[1].trim();
  if (label.includes('CERTIFICATE')) throw new KeyFormatError('KEY_CERTIFICATE', 'This is a certificate, not a private key');
  if (label.includes('PUBLIC KEY')) throw new KeyFormatError('KEY_PUBLIC', 'This is a public key, not a private key');
  if (label === 'ENCRYPTED PRIVATE KEY' || /Proc-Type:\s*4,\s*ENCRYPTED/i.test(text)) {
    throw new KeyFormatError('KEY_ENCRYPTED', 'Password-protected private keys are not supported');
  }
  if (label === 'EC PRIVATE KEY' || label === 'DSA PRIVATE KEY') {
    throw new KeyFormatError('KEY_NOT_RSA', 'Only RSA private keys are supported');
  }
  if (label !== 'PRIVATE KEY' && label !== 'RSA PRIVATE KEY') {
    throw new KeyFormatError('KEY_NOT_PEM', 'This is not a PEM private key');
  }

  const endMarker = `-----END ${label}-----`;
  const bodyStart = begin.index + begin[0].length;
  const endIndex = text.indexOf(endMarker, bodyStart);
  if (endIndex === -1) throw new KeyFormatError('KEY_TRUNCATED', 'The private key is incomplete (the END line is missing)');

  const body = text.slice(bodyStart, endIndex).replace(/\s+/g, '');
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
    throw new KeyFormatError('KEY_NOT_PEM', 'This is not a PEM private key');
  }
  const pemIn = `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g).join('\n')}\n${endMarker}\n`;

  let key;
  try {
    key = createPrivateKey({ key: pemIn, format: 'pem' });
  } catch {
    throw new KeyFormatError('KEY_TRUNCATED', 'The private key could not be read; it may be incomplete');
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new KeyFormatError('KEY_NOT_RSA', 'Only RSA private keys are supported');
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_RSA_BITS) {
    throw new KeyFormatError('KEY_TOO_SMALL', `RSA keys must be at least ${MIN_RSA_BITS} bits`);
  }
  return {
    pem: key.export({ type: 'pkcs8', format: 'pem' }).toString(),
    bits,
    fingerprint: keyFingerprint(key),
  };
}

/**
 * `SHA256:` + the first 16 base64 chars of sha256(SPKI DER of the public key).
 * Identifies an installed key without exposing it.
 */
export function keyFingerprint(privateKey) {
  const der = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return `SHA256:${createHash('sha256').update(der).digest('base64').slice(0, 16)}`;
}

const APP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Enable Banking application ids are UUIDs. */
export const isValidAppId = (appId) => typeof appId === 'string' && APP_ID_PATTERN.test(appId.trim());

/** sha256 hex (first 32 chars) of the case-folded app id: compared without decrypting. */
export const appIdHash = (appId) => createHash('sha256').update(String(appId).trim().toLowerCase()).digest('hex').slice(0, 32);

/** Error codes Enable Banking returns when a session can no longer be used. */
const CONSENT_ERROR_PATTERN = /EXPIRED|REVOKED|SESSION|CONSENT|UNAUTHORI[SZ]ED/i;
/** The subset that names the session or consent itself (reconnect, not credentials). */
export const SESSION_ERROR_PATTERN = /EXPIRED|REVOKED|SESSION|CONSENT/i;

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
    /** GET /application → the app's own details (the credential probe, #148). */
    getApplication: () => request('GET', '/application'),
  };
}

/**
 * A 401/403 that does not name the session or consent: possibly the app's
 * credentials (#148, D5). The caller confirms with `probeApplication`.
 */
export function isCredentialError(err) {
  return err instanceof EnableBankingError
    && (err.status === 401 || err.status === 403)
    && !(err.code && SESSION_ERROR_PATTERN.test(err.code));
}

/**
 * Checks a client's credentials with GET /application (#148, D6).
 *
 * @param {{ getApplication: () => Promise<any> }} client
 * @param {{ callbackUrl?: string }} [opts]
 * @returns {Promise<{ result: 'VERIFIED' | 'INVALID' | 'SANDBOX' | 'UNREACHABLE', callbackRegistered: boolean | null, httpStatus?: number }>}
 *   INVALID: 401/403/404 (unknown app, key mismatch). UNREACHABLE: network,
 *   timeout, 429 or 5xx. Other errors are rethrown.
 */
export async function probeApplication(client, { callbackUrl } = {}) {
  let app;
  try {
    app = await client.getApplication();
  } catch (err) {
    if (!(err instanceof EnableBankingError)) throw err;
    if ([401, 403, 404].includes(err.status)) return { result: 'INVALID', callbackRegistered: null, httpStatus: err.status };
    if (err.retryable || err.status === 0) return { result: 'UNREACHABLE', callbackRegistered: null, httpStatus: err.status };
    return { result: 'INVALID', callbackRegistered: null, httpStatus: err.status };
  }
  // Field names are read defensively: an absent field is "unknown", never a failure.
  if (typeof app?.environment === 'string' && /SANDBOX/i.test(app.environment)) {
    return { result: 'SANDBOX', callbackRegistered: null };
  }
  const urls = Array.isArray(app?.redirect_urls) ? app.redirect_urls : null;
  const callbackRegistered = urls && callbackUrl
    ? urls.some((u) => typeof u === 'string' && u.replace(/\/+$/, '') === callbackUrl.replace(/\/+$/, ''))
    : null;
  return { result: 'VERIFIED', callbackRegistered };
}

/**
 * Per-process cache of tenant clients keyed `tenantId:credentialId:version`
 * (#148, D2), so a signed JWT is reused while valid and a credential change
 * (version bump, or a new row after Remove + Set) takes effect on the next
 * call on every instance. Bounded LRU.
 *
 * @param {{ max?: number, baseUrl?: string, fetchImpl?: typeof fetch }} [opts]
 */
export function createTenantClientCache({ max = 200, baseUrl, fetchImpl } = {}) {
  const entries = new Map(); // key → client (insertion order = recency)

  return {
    /**
     * @param {{ id?: string, tenantId: string, version: number, appId: string, privateKey: string }} credential
     */
    get(credential) {
      const key = `${credential.tenantId}:${credential.id ?? ''}:${credential.version}`;
      const hit = entries.get(key);
      if (hit) {
        entries.delete(key);
        entries.set(key, hit);
        return hit;
      }
      for (const k of entries.keys()) {
        if (k.startsWith(`${credential.tenantId}:`)) entries.delete(k);
      }
      const client = createClient({
        appId: credential.appId,
        privateKey: credential.privateKey,
        baseUrl: baseUrl ?? getBaseUrl(),
        ...(fetchImpl && { fetchImpl }),
      });
      entries.set(key, client);
      while (entries.size > max) entries.delete(entries.keys().next().value);
      return client;
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
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
