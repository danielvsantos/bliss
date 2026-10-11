/**
 * Enable Banking helpers for the API routes (#132).
 *
 * - `isEnableBankingEnabled()` / `getEnableBankingClient()`: env-driven; the
 *   feature is hidden (404 NOT_ENABLED) when the app id or key is absent.
 * - `signState()` / `consumeState()`: the callback's only authority (D6). A
 *   base64url JSON payload `{ t, u, r?, n, exp }` + HMAC-SHA256 under a key
 *   HKDF-derived from NEXTAUTH_SECRET, valid 15 minutes, single use through a
 *   Redis nonce (`SET NX EX` at connect, `GETDEL` at callback).
 * - `suggestAccountId()`: R5 pre-selection by IBAN last 4 + currency.
 * - `budgetStatus()`: read-only view of the worker's per-account daily budget.
 *
 * See docs/specs/api/27-enable-banking-api.md.
 */

import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createClient,
  loadPrivateKey,
  getEnableBankingConfig,
  budgetKey,
  budgetDay,
  budgetResetsAt,
  getDailyBudget,
} from '@bliss/shared/enablebanking';
import { getRedisClient } from './redisClient.js';
import { rateLimiters } from './rateLimit.js';

export const PROVIDER = 'ENABLE_BANKING';
export const STATE_TTL_SECONDS = 15 * 60;
const NONCE_PREFIX = 'ebstate:v1:';
/** Safety margin subtracted from the bank's maximum consent validity. */
export const CONSENT_SAFETY_MARGIN_MS = 24 * 60 * 60 * 1000;
/** Fallback when the bank does not report a maximum consent validity (90 days). */
const DEFAULT_CONSENT_SECONDS = 90 * 24 * 60 * 60;

/** Applies the Enable Banking rate limiter (same promise wrapper as the Plaid routes). */
export function applyRateLimit(req, res) {
  return new Promise((resolve, reject) => {
    const limiter = rateLimiters.enableBanking || rateLimiters.common;
    if (!limiter) return resolve();
    limiter(req, res, (result) => (result instanceof Error ? reject(result) : resolve(result)));
  });
}

export function isEnableBankingEnabled() {
  return getEnableBankingConfig().enabled;
}

let client = null;

export function getEnableBankingClient() {
  if (client) return client;
  const config = getEnableBankingConfig();
  if (!config.enabled) return null;
  client = createClient({ appId: config.appId, privateKey: loadPrivateKey(), baseUrl: config.baseUrl });
  return client;
}

/** Tests only. */
export function __setEnableBankingClientForTests(c) {
  client = c;
}

/** The redirect URL registered on the Enable Banking app. */
export function getCallbackUrl() {
  const explicit = (process.env.ENABLE_BANKING_REDIRECT_URL || '').trim();
  if (explicit) return explicit;
  const base = process.env.NEXTAUTH_URL || 'http://localhost:3000';
  return `${new URL(base).origin}/api/enablebanking/callback`;
}

export function getFrontendUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:8080').replace(/\/+$/, '');
}

/** `valid_until` for POST /auth: now + the bank's maximum consent − 1 day. */
export function consentValidUntil(maximumConsentValiditySec, now = new Date()) {
  const seconds = Number(maximumConsentValiditySec) > 0 ? Number(maximumConsentValiditySec) : DEFAULT_CONSENT_SECONDS;
  const ms = Math.max(seconds * 1000 - CONSENT_SAFETY_MARGIN_MS, 60 * 60 * 1000);
  return new Date(now.getTime() + ms);
}

// ── Signed, single-use state ───────────────────────────────────────────────

function stateKey() {
  const secret = process.env.NEXTAUTH_SECRET || process.env.JWT_SECRET_CURRENT;
  if (!secret) throw new Error('NEXTAUTH_SECRET is required to sign Enable Banking state');
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'enablebanking-state', 32));
}

const mac = (payload) => createHmac('sha256', stateKey()).update(payload).digest('base64url');

/**
 * Signs a state for POST /auth and stores its nonce in Redis.
 * Throws when Redis is unavailable: without it the state cannot be single use.
 */
export async function signState({ tenantId, userId, reconnectItemId = null, now = Date.now() }) {
  const redis = getRedisClient();
  if (!redis) throw new Error('REDIS_UNAVAILABLE');
  const nonce = randomBytes(16).toString('base64url');
  const body = {
    t: tenantId,
    u: userId,
    ...(reconnectItemId && { r: reconnectItemId }),
    n: nonce,
    exp: Math.floor(now / 1000) + STATE_TTL_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  const ok = await redis.set(`${NONCE_PREFIX}${nonce}`, '1', 'EX', STATE_TTL_SECONDS, 'NX');
  if (ok !== 'OK') throw new Error('STATE_NONCE_COLLISION');
  return `${payload}.${mac(payload)}`;
}

/**
 * Verifies and consumes a state. Returns `{ tenantId, userId, reconnectItemId }`
 * or null when it is missing, malformed, tampered, expired or already used.
 */
export async function consumeState(state, now = Date.now()) {
  if (typeof state !== 'string' || state.length > 2048) return null;
  const [payload, signature, extra] = state.split('.');
  if (!payload || !signature || extra !== undefined) return null;

  const expected = Buffer.from(mac(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  let body;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!body?.t || !body?.u || !body?.n || typeof body.exp !== 'number') return null;
  if (body.exp <= Math.floor(now / 1000)) return null;

  const redis = getRedisClient();
  if (!redis) return null;
  const used = await redis.getdel(`${NONCE_PREFIX}${body.n}`);
  if (used === null) return null; // replayed (or expired in Redis)

  return { tenantId: body.t, userId: body.u, reconnectItemId: body.r || null };
}

// ── Account matching (R5) ──────────────────────────────────────────────────

/** Last 4 alphanumerics of an IBAN / account number, upper-cased. */
export function lastFour(value) {
  if (!value) return null;
  const clean = String(value).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return clean.length >= 4 ? clean.slice(-4) : null;
}

/**
 * The id of the Bliss account that best matches a bank account: same last 4
 * (account number or Plaid mask) and same currency. Null when there is no
 * match or the match is ambiguous.
 *
 * @param {{ ibanLast4: string|null, currency: string|null }} ebAccount
 * @param {{ id: number, accountNumber: string, mask: string|null, currencyCode: string }[]} accounts
 */
export function suggestAccountId(ebAccount, accounts) {
  const target = ebAccount?.ibanLast4 ? String(ebAccount.ibanLast4).toUpperCase() : null;
  if (!target) return null;
  const matches = accounts.filter((a) => {
    if (ebAccount.currency && a.currencyCode && a.currencyCode !== ebAccount.currency) return false;
    return lastFour(a.accountNumber) === target || (a.mask && lastFour(a.mask) === target);
  });
  return matches.length === 1 ? matches[0].id : null;
}

// ── Budget (read-only; the worker's INCR is the authority) ─────────────────

/**
 * @param {string[]} ebAccountIds mapped accounts of the connection
 * @returns {Promise<{ exhausted: boolean, resetsAt: string, limit: number, used: Record<string, number> }>}
 */
export async function budgetStatus(ebAccountIds, now = new Date()) {
  const limit = getDailyBudget();
  const resetsAt = budgetResetsAt(now).toISOString();
  const redis = getRedisClient();
  if (!redis || ebAccountIds.length === 0) {
    // Unknown is not "spent": let the worker decide.
    return { exhausted: false, resetsAt, limit, used: {} };
  }
  const day = budgetDay(now);
  let values;
  try {
    values = await redis.mget(...ebAccountIds.map((id) => budgetKey(id, day)));
  } catch {
    return { exhausted: false, resetsAt, limit, used: {} };
  }
  const used = Object.fromEntries(ebAccountIds.map((id, i) => [id, Number(values[i] || 0)]));
  const exhausted = ebAccountIds.every((id) => used[id] >= limit);
  return { exhausted, resetsAt, limit, used };
}
