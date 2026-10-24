/**
 * POST /api/etoro/connections/:id/sync — "Sync now" (#143, R4), admin only.
 *
 * → 202 { message } and an ETORO_SYNC job (deduplicated per connection).
 * → 400 CONNECTION_NOT_ACTIVE · 404 NOT_FOUND
 * → 429 COOLDOWN { retryAfter } — one manual sync per connection every 15 minutes.
 *
 * Session only: /api/etoro is on INTEGRATION_DENYLIST.
 */

import { StatusCodes } from 'http-status-codes';
import { withAuth } from '../../../../../utils/withAuth.js';
import { applyEtoroRateLimit, sendEtoroError } from '../../../../../utils/etoroRoute.js';
import { armSyncCooldown, syncCooldownRemaining } from '../../../../../utils/etoro.js';
import { loadSyncableConnection, triggerSync } from '../../../../../services/etoro.service.js';

export default withAuth(async function handler(req, res) {
  await applyEtoroRateLimit(req, res);

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  try {
    const connection = await loadSyncableConnection(req.user.tenantId, req.query.id);
    const retryAfter = await syncCooldownRemaining(connection.id);
    if (retryAfter > 0) {
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(StatusCodes.TOO_MANY_REQUESTS).json({
        error: 'This connection was synced recently. Try again later.',
        code: 'COOLDOWN',
        retryAfter,
      });
    }
    await armSyncCooldown(connection.id);
    await triggerSync(req.user.tenantId, connection.id);
    return res.status(StatusCodes.ACCEPTED).json({ message: 'Sync triggered' });
  } catch (error) {
    return sendEtoroError(res, error, 'sync');
  }
}, { requireRole: 'admin' });
