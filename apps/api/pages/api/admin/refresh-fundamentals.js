/**
 * Admin Maintenance proxy — manually triggers a SecurityMaster fundamentals
 * refresh. Mirrors the `admin/rebuild` proxy pattern: this layer enforces the
 * admin role + rate limit, then forwards to the backend's existing internal
 * `POST /api/security-master/refresh-all` endpoint with the `INTERNAL_API_KEY`.
 *
 *   POST /api/admin/refresh-fundamentals
 *     Body: (none)
 *     Enqueues the `refresh-all-fundamentals` BullMQ job, which iterates every
 *     active stock symbol across all tenants and calls
 *     `securityMasterService.upsertFundamentals(...)` for each.
 *
 *     Responses:
 *       202 { message, jobId }   — accepted, refresh running in the background
 *       403 { error }            — non-admin
 *       500 { error }            — backend not configured / unexpected
 *
 * Auth: tenant-admin only (user.role === 'admin'). Note that the underlying
 * job is global — it refreshes every active stock symbol across all tenants —
 * because SecurityMaster is a global, non-tenant-scoped table. Any admin on
 * any tenant can therefore refresh the global table; this is intentional and
 * matches the nightly cron's behavior.
 */

import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';

import { withAuth } from '../../../utils/withAuth.js';
import { cors } from '../../../utils/cors.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { fetchWithTimeout } from '../../../utils/fetchWithTimeout.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const BACKEND_API_KEY = process.env.INTERNAL_API_KEY;

// 30s matches the admin/rebuild proxy. Enqueueing is fast (Redis SADD-equivalent),
// but Redis under contention from an active refresh can briefly stall.
const FETCH_TIMEOUT_MS = 30_000;

async function applyRateLimit(limiter, req, res) {
  await new Promise((resolve, reject) => {
    limiter(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });
}

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
    console.error('[admin/refresh-fundamentals] INTERNAL_API_KEY is not configured');
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Backend not configured' });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).json({ error: 'Method not allowed' });
  }

  try {
    // Reuse the rebuild trigger limiter — same usage profile (admin-only,
    // expensive backend operation, no need for a separate budget).
    await applyRateLimit(rateLimiters.rebuildTrigger, req, res);
    if (res.writableEnded) return;

    const backendRes = await fetchWithTimeout(
      `${BACKEND_URL}/api/security-master/refresh-all`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': BACKEND_API_KEY,
        },
        body: JSON.stringify({}),
      },
      FETCH_TIMEOUT_MS,
    );

    const json = await safeJson(backendRes);
    return res.status(backendRes.status).json(json);
  } catch (error) {
    console.error('[admin/refresh-fundamentals] Unexpected error:', error);
    Sentry.captureException(error, {
      extra: { route: 'admin/refresh-fundamentals', method: req.method },
    });
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Unexpected error' });
  }
}, { requireRole: 'admin' });
