import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../prisma/prisma.js';
import { requestIp } from '../utils/apiKeys.js';
import { timingSafeCompare } from '../utils/timingSafeCompare.js';
import {
  REFRESH_COOKIE,
  clearSessionCookies,
  setAuthCookie,
  setRefreshCookie,
} from '../utils/cookieUtils.js';

/**
 * Session lifecycle (#156): short access JWT + rotating refresh token.
 *
 * One `UserSession` row per signed-in device ("family"). The refresh cookie is
 * `<sessionId>.<secret>`; only the SHA-256 of the secret is stored, as
 * `tokenHash` (current) and `previousTokenHash` (the one it replaced). Because
 * the id travels with the token, any stale token of a family maps back to it,
 * so reuse detection covers the whole chain with one row per device.
 *
 * Lifetimes are server-side constants (no env vars):
 *   - access JWT 15 min, carrying `auth_time` (the real sign-in) and `iat_ms`;
 *   - a family lives at most 15 days from creation and ends after 7 days
 *     without a refresh. Refresh never moves `authenticatedAt` or
 *     `absoluteExpiresAt`.
 *
 * Tenant isolation: the first lookup is by the random, unguessable id (like
 * `ApiKey.prefix`); every later read and write is scoped by the row's
 * `tenantId` + `userId`. User-initiated queries use `req.user`'s ids.
 *
 * Raw tokens, user agents and IPs are never logged.
 */

export const ACCESS_TTL_S = 15 * 60;
export const IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ABSOLUTE_TTL_MS = 15 * 24 * 60 * 60 * 1000;
export const REAUTH_WINDOW_S = 15 * 60;
export const GRACE_MS = 10_000;
const PRUNE_REVOKED_AFTER_MS = 24 * 60 * 60 * 1000;
const USER_AGENT_MAX = 200;

export const SESSION_EXPIRED = 'SESSION_EXPIRED';
export const SESSION_REVOKED = 'SESSION_REVOKED';

function jwtSecret() {
  const secret = process.env.JWT_SECRET_CURRENT || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET_CURRENT or JWT_SECRET must be set in environment variables');
  }
  return secret;
}

export function hashSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function newSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Parses `<sessionId>.<secret>`; null when malformed. */
export function parseRefreshToken(value) {
  if (typeof value !== 'string') return null;
  const match = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return null;
  return { sessionId: match[1], secret: match[2] };
}

/**
 * Short "browser on OS" summary of a User-Agent header. Never the raw header.
 * @param {string | undefined} ua
 * @returns {string | null}
 */
export function summarizeUserAgent(ua) {
  if (typeof ua !== 'string' || ua.trim() === '') return null;
  const browser =
    (/Edg\//.test(ua) && 'Edge')
    || (/OPR\/|Opera/.test(ua) && 'Opera')
    || (/Firefox\/|FxiOS/.test(ua) && 'Firefox')
    || (/Chrome\/|CriOS/.test(ua) && 'Chrome')
    || (/Safari\//.test(ua) && 'Safari')
    || 'Other';
  const os =
    (/iPhone|iPad|iPod/.test(ua) && 'iOS')
    || (/Android/.test(ua) && 'Android')
    || (/Windows/.test(ua) && 'Windows')
    || (/Mac OS X|Macintosh/.test(ua) && 'macOS')
    || (/CrOS/.test(ua) && 'ChromeOS')
    || (/Linux/.test(ua) && 'Linux')
    || 'Other';
  return `${browser} on ${os}`.slice(0, USER_AGENT_MAX);
}

/**
 * Signs a 15-minute access JWT. `authenticatedAt` is the family's real
 * sign-in time (`auth_time`); `iat_ms` lets withAuth compare against
 * `User.sessionsRevokedAt` at millisecond precision.
 */
export function signAccessToken(user, authenticatedAt, now = new Date()) {
  return jwt.sign(
    {
      jti: uuidv4(),
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      auth_time: Math.floor(authenticatedAt.getTime() / 1000),
      iat_ms: now.getTime(),
    },
    jwtSecret(),
    { expiresIn: ACCESS_TTL_S },
  );
}

function idleExpiry(now, absoluteExpiresAt) {
  return new Date(Math.min(now.getTime() + IDLE_TTL_MS, absoluteExpiresAt.getTime()));
}

function refreshMaxAge(idleExpiresAt, now) {
  return Math.floor((idleExpiresAt.getTime() - now.getTime()) / 1000);
}

function isLive(row, now) {
  return Boolean(row)
    && !row.revokedAt
    && row.idleExpiresAt.getTime() > now.getTime()
    && row.absoluteExpiresAt.getTime() > now.getTime();
}

/** Fire-and-forget: drop this user's dead families (R23). */
export function pruneUserSessions(tenantId, userId, now = new Date()) {
  prisma.userSession
    .deleteMany({
      where: {
        tenantId,
        userId,
        OR: [
          { absoluteExpiresAt: { lt: now } },
          { idleExpiresAt: { lt: now } },
          { revokedAt: { lt: new Date(now.getTime() - PRUNE_REVOKED_AFTER_MS) } },
        ],
      },
    })
    .catch((err) => console.warn('session: prune failed', { message: err?.message }));
}

/**
 * Starts a new family for `user` (every sign-in path) and sets both cookies.
 * @param {import('next').NextApiResponse} res
 * @param {{ id: string, tenantId: string, email: string }} user
 * @param {import('next').NextApiRequest} req
 * @returns {Promise<{ sessionId: string }>}
 */
export async function startSession(res, user, req, { now = new Date() } = {}) {
  const sessionId = crypto.randomBytes(16).toString('base64url');
  const secret = newSecret();
  const absoluteExpiresAt = new Date(now.getTime() + ABSOLUTE_TTL_MS);
  const idleExpiresAt = idleExpiry(now, absoluteExpiresAt);

  await prisma.userSession.create({
    data: {
      id: sessionId,
      tenantId: user.tenantId,
      userId: user.id,
      tokenHash: hashSecret(secret),
      authenticatedAt: now,
      absoluteExpiresAt,
      idleExpiresAt,
      lastUsedAt: now,
      userAgent: summarizeUserAgent(req?.headers?.['user-agent']),
      ipAddress: req ? requestIp(req) : null,
    },
  });

  setAuthCookie(res, signAccessToken(user, now, now));
  setRefreshCookie(res, `${sessionId}.${secret}`, refreshMaxAge(idleExpiresAt, now));
  pruneUserSessions(user.tenantId, user.id, now);
  return { sessionId };
}

/**
 * Resolves the request's refresh cookie to a live family whose current or
 * previous hash matches. Used where the cookie authenticates a request
 * (sign-out-others, reauth, signout, the Google step-up) without rotating it.
 * @returns {Promise<object | null>} the UserSession row
 */
export async function findLiveSession(req, { now = new Date() } = {}) {
  const parsed = parseRefreshToken(req.cookies?.[REFRESH_COOKIE]);
  if (!parsed) return null;
  const row = await prisma.userSession.findUnique({ where: { id: parsed.sessionId } });
  if (!isLive(row, now)) return null;
  const hash = hashSecret(parsed.secret);
  if (!timingSafeCompare(hash, row.tokenHash) && !timingSafeCompare(hash, row.previousTokenHash ?? '')) {
    return null;
  }
  return row;
}

function fail(res, code) {
  clearSessionCookies(res);
  return { ok: false, status: 401, code };
}

async function revokeFamily(row, reason, now) {
  await prisma.userSession.updateMany({
    where: { id: row.id, tenantId: row.tenantId, userId: row.userId, revokedAt: null },
    data: { revokedAt: now, revokedReason: reason },
  });
}

/**
 * Rotates the family from `presentedHash`. Returns false when a concurrent
 * request moved the family first.
 */
async function rotate(res, row, user, presentedHash, expectedCurrent, now) {
  const secret = newSecret();
  const idleExpiresAt = idleExpiry(now, row.absoluteExpiresAt);
  const { count } = await prisma.userSession.updateMany({
    where: {
      id: row.id,
      tenantId: row.tenantId,
      userId: row.userId,
      tokenHash: expectedCurrent,
      revokedAt: null,
    },
    data: {
      tokenHash: hashSecret(secret),
      previousTokenHash: presentedHash,
      rotatedAt: now,
      idleExpiresAt,
      lastUsedAt: now,
    },
  });
  if (count !== 1) return false;
  setAuthCookie(res, signAccessToken(user, row.authenticatedAt, now));
  setRefreshCookie(res, `${row.id}.${secret}`, refreshMaxAge(idleExpiresAt, now));
  return true;
}

/**
 * `POST /api/auth/refresh` (R7–R10). Decision table (presented token P,
 * family F):
 *   - F missing / revoked / idle- or absolute-expired / user gone → 401
 *   - hash(P) == F.tokenHash → rotate (atomic; a lost race re-reads F)
 *   - hash(P) == F.previousTokenHash, same device, ≤ 10 s since rotation →
 *     grace: new access cookie only (the concurrent request already stored
 *     the successor in the shared cookie jar)
 *   - hash(P) == F.previousTokenHash, same device, > 10 s → lost response:
 *     rotate again from P (the successor was provably never presented)
 *   - anything else → reuse: revoke F, 401, log `refresh_token_reuse`
 * Every failure clears both cookies.
 *
 * @returns {Promise<{ ok: true } | { ok: false, status: number, code: string }>}
 */
export async function refreshSession(req, res, { now = new Date() } = {}) {
  const parsed = parseRefreshToken(req.cookies?.[REFRESH_COOKIE]);
  if (!parsed) return fail(res, SESSION_EXPIRED);

  let row = await prisma.userSession.findUnique({ where: { id: parsed.sessionId } });
  if (!row) return fail(res, SESSION_EXPIRED);
  if (row.revokedAt) return fail(res, SESSION_REVOKED);
  if (!isLive(row, now)) return fail(res, SESSION_EXPIRED);

  const user = await prisma.user.findFirst({
    where: { id: row.userId, tenantId: row.tenantId },
    select: { id: true, tenantId: true, email: true },
  });
  if (!user) return fail(res, SESSION_EXPIRED);

  const presented = hashSecret(parsed.secret);

  if (timingSafeCompare(presented, row.tokenHash)) {
    if (await rotate(res, row, user, presented, presented, now)) {
      pruneUserSessions(row.tenantId, row.userId, now);
      return { ok: true };
    }
    // A concurrent request rotated first: re-read and treat P as previous.
    row = await prisma.userSession.findFirst({
      where: { id: row.id, tenantId: row.tenantId, userId: row.userId },
    });
    if (!isLive(row, now)) return fail(res, row?.revokedAt ? SESSION_REVOKED : SESSION_EXPIRED);
  }

  const sameDevice = summarizeUserAgent(req.headers?.['user-agent']) === (row.userAgent ?? null);
  if (row.previousTokenHash && timingSafeCompare(presented, row.previousTokenHash) && sameDevice) {
    const sinceRotation = row.rotatedAt ? now.getTime() - row.rotatedAt.getTime() : Infinity;
    if (sinceRotation <= GRACE_MS) {
      setAuthCookie(res, signAccessToken(user, row.authenticatedAt, now));
      return { ok: true };
    }
    if (await rotate(res, row, user, presented, row.tokenHash, now)) return { ok: true };
  }

  await revokeFamily(row, 'reuse', now);
  console.warn(JSON.stringify({
    event: 'refresh_token_reuse',
    tenantId: row.tenantId,
    userId: row.userId,
    sessionId: row.id,
  }));
  return fail(res, SESSION_REVOKED);
}

/**
 * Signout (R14): revokes the request's family when its cookie matches, and
 * clears both cookies either way.
 */
export async function revokeSession(req, res, { now = new Date() } = {}) {
  const row = await findLiveSession(req, { now });
  if (row) await revokeFamily(row, 'signout', now);
  clearSessionCookies(res);
}

/**
 * "Sign out of all other devices" (R16): authenticated by the refresh
 * cookie. Sets `sessionsRevokedAt` and revokes every other family in one
 * transaction, then gives this device a fresh access token (minted at the
 * same instant, so it is not older than the revocation).
 * @returns {Promise<{ ok: true, revoked: number } | { ok: false, status: number, code: string }>}
 */
export async function revokeOtherSessions(req, res, { now = new Date() } = {}) {
  const row = await findLiveSession(req, { now });
  if (!row) return fail(res, SESSION_EXPIRED);

  const [user, revoked] = await prisma.$transaction([
    prisma.user.update({
      where: { id: row.userId, tenantId: row.tenantId },
      data: { sessionsRevokedAt: now },
      select: { id: true, tenantId: true, email: true },
    }),
    prisma.userSession.updateMany({
      where: { tenantId: row.tenantId, userId: row.userId, revokedAt: null, id: { not: row.id } },
      data: { revokedAt: now, revokedReason: 'sign_out_others' },
    }),
  ]);

  setAuthCookie(res, signAccessToken(user, row.authenticatedAt, now));
  return { ok: true, revoked: revoked.count };
}

/**
 * Password change (R15): sets `sessionsRevokedAt`, revokes every family and
 * stores the new password in one transaction, then starts a fresh family for
 * the device that made the change.
 */
export async function revokeAllAndRestart(res, user, req, { passwordData, now = new Date() } = {}) {
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id, tenantId: user.tenantId },
      data: { ...passwordData, sessionsRevokedAt: now },
    }),
    prisma.userSession.updateMany({
      where: { tenantId: user.tenantId, userId: user.id, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'password_change' },
    }),
  ]);
  return startSession(res, user, req, { now });
}

/**
 * Step-up (R19): marks the family as freshly authenticated and issues a new
 * access token. The absolute cap is unchanged. Without a live family of this
 * user (e.g. a legacy 24h token), a new family is started instead — the
 * caller has just proven a credential.
 */
export async function reauthenticate(req, res, user, { now = new Date(), session } = {}) {
  const row = session === undefined ? await findLiveSession(req, { now }) : session;
  if (row && row.userId === user.id && row.tenantId === user.tenantId) {
    await prisma.userSession.updateMany({
      where: { id: row.id, tenantId: row.tenantId, userId: row.userId, revokedAt: null },
      data: { authenticatedAt: now, lastUsedAt: now },
    });
    setAuthCookie(res, signAccessToken(user, now, now));
    return { sessionId: row.id, started: false };
  }
  if (row) await revokeFamily(row, 'user_switch', now);
  const started = await startSession(res, user, req, { now });
  return { ...started, started: true };
}
