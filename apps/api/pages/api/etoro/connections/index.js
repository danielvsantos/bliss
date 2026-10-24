/**
 * eToro copy trading connections (#143).
 *
 * GET  /api/etoro/connections
 *   → 200 { connections } — every role; keys are never returned (keyLast4 only).
 * POST /api/etoro/connections   (admin)
 *   Body: { apiKey, userKey, accountId }
 *   → 201 { connection, copies } — the eToro username and the copies on the account
 *   → 400 KEYS_REQUIRED | ACCOUNT_REQUIRED | ACCOUNT_NOT_FOUND | ETORO_WRITE_SCOPE { writeScopes }
 *   → 409 ETORO_ALREADY_CONNECTED · 422 ETORO_KEY_INVALID · 429 ETORO_RATE_LIMITED · 502 ETORO_UNAVAILABLE
 *   Nothing is stored unless eToro accepts a read-only key. Starts a sync.
 *
 * Session only: /api/etoro is on INTEGRATION_DENYLIST.
 */

import { StatusCodes } from 'http-status-codes';
import { withAuth } from '../../../../utils/withAuth.js';
import { applyEtoroRateLimit, forbidden, sendEtoroError } from '../../../../utils/etoroRoute.js';
import { connect, listConnections } from '../../../../services/etoro.service.js';

export const config = { api: { bodyParser: { sizeLimit: '8kb' } } };

export default withAuth(async function handler(req, res) {
  await applyEtoroRateLimit(req, res);

  try {
    if (req.method === 'GET') {
      return res.status(StatusCodes.OK).json({ connections: await listConnections(req.user.tenantId) });
    }
    if (req.method === 'POST') {
      if (req.user.role !== 'admin') return forbidden(res);
      const result = await connect({ tenantId: req.user.tenantId, userId: req.user.id, body: req.body });
      return res.status(result.reactivated ? StatusCodes.OK : StatusCodes.CREATED).json({
        connection: result.connection,
        copies: result.copies,
      });
    }
    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  } catch (error) {
    return sendEtoroError(res, error, 'connections');
  }
});
