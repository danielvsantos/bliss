/**
 * Admin Maintenance proxy — forwards rebuild trigger/status requests to
 * the backend, stamping the authenticated tenantId + requestedBy from
 * the JWT so the client never gets to choose those.
 *
 *   POST /api/admin/rebuild
 *     Body: { scope, payload? }
 *     - scope: 'full-portfolio' | 'full-analytics' | 'scoped-analytics' | 'single-asset'
 *     - payload.earliestDate required for scoped-analytics (ISO date string)
 *     - payload.portfolioItemId required for single-asset (number)
 *
 *     Forwards to backend `POST /api/admin/rebuild/trigger` with
 *     `tenantId = user.tenantId` and `requestedBy = user.email` injected
 *     server-side. The client never names the tenant; that comes from
 *     the verified JWT.
 *
 *     Responses:
 *       202 { status, scope, requestedAt, lockTtlSeconds }   — accepted
 *       409 { error, scope, ttlSeconds }                     — already running
 *       403 { error }                                        — non-admin
 *       400 { error }                                        — validation
 *
 *   GET /api/admin/rebuild
 *     Forwards to backend `GET /api/admin/rebuild/status?tenantId=...`.
 *     Returns `{ locks, current, recent }` exactly as the backend
 *     serializes them.
 *
 * Auth: tenant-admin only (user.role === 'admin') — enforced by
 * withAuth({ requireRole: 'admin' }) which returns 403 for member/viewer.
 */

import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';

import { withAuth } from '../../../utils/withAuth.js';
import { cors } from '../../../utils/cors.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { fetchWithTimeout } from '../../../utils/fetchWithTimeout.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const BACKEND_API_KEY = process.env.INTERNAL_API_KEY;

const VALID_SCOPES = new Set([
  'full-portfolio',
  'full-analytics',
  'scoped-analytics',
  'single-asset',
]);

const FETCH_TIMEOUT_MS = 10_000;

async function applyRateLimit(limiter, req, res) {
  await new Promise((resolve, reject) => {
    limiter(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });
}

async function handleTrigger(req, res, user) {
  await applyRateLimit(rateLimiters.rebuildTrigger, req, res);
  if (res.writableEnded) return;

  const { scope, payload } = req.body || {};

  if (!scope || !VALID_SCOPES.has(scope)) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: `scope must be one of: ${[...VALID_SCOPES].join(', ')}`,
    });
  }

  // Payload validation — mirrored on the backend too, but failing fast
  // here saves a round-trip and gives a more direct error surface.
  if (scope === 'scoped-analytics') {
    const d = payload?.earliestDate;
    if (!d || Number.isNaN(Date.parse(d))) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'payload.earliestDate (ISO date) is required for scope=scoped-analytics',
      });
    }
  }
  if (scope === 'single-asset') {
    const id = payload?.portfolioItemId;
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'payload.portfolioItemId (number) is required for scope=single-asset',
      });
    }
  }

  const body = {
    tenantId: user.tenantId,             // server-side injection — never from client
    scope,
    requestedBy: user.email || user.id,  // audit trail, displayed in rebuild history
    payload: payload || null,
  };

  const backendRes = await fetchWithTimeout(
    `${BACKEND_URL}/api/admin/rebuild/trigger`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': BACKEND_API_KEY,
      },
      body: JSON.stringify(body),
    },
    FETCH_TIMEOUT_MS,
  );

  const json = await safeJson(backendRes);
  return res.status(backendRes.status).json(json);
}

async function handleStatus(req, res, user) {
  await applyRateLimit(rateLimiters.rebuildStatus, req, res);
  if (res.writableEnded) return;

  const url = new URL(`${BACKEND_URL}/api/admin/rebuild/status`);
  url.searchParams.set('tenantId', user.tenantId);

  const backendRes = await fetchWithTimeout(
    url.toString(),
    {
      method: 'GET',
      headers: { 'x-api-key': BACKEND_API_KEY },
    },
    FETCH_TIMEOUT_MS,
  );

  const json = await safeJson(backendRes);
  return res.status(backendRes.status).json(json);
}

// Defensive parse — the backend should always return JSON for these
// routes, but if it returns HTML on an unexpected error, don't crash
// the proxy.
async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    const text = await response.text().catch(() => '');
    return { error: 'Non-JSON response from backend', body: text.slice(0, 500) };
  }
}

export default withAuth(async function handler(req, res) {
  if (cors(req, res)) return;

  if (!BACKEND_API_KEY) {
    console.error('[admin/rebuild] INTERNAL_API_KEY is not configured');
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Backend not configured' });
  }

  const user = req.user;

  try {
    switch (req.method) {
      case 'POST':
        return await handleTrigger(req, res, user);
      case 'GET':
        return await handleStatus(req, res, user);
      default:
        return res.status(StatusCodes.METHOD_NOT_ALLOWED).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('[admin/rebuild] Unexpected error:', error);
    Sentry.captureException(error, { extra: { route: 'admin/rebuild', method: req.method } });
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Unexpected error' });
  }
}, { requireRole: 'admin' });
