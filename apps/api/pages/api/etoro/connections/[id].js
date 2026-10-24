/**
 * One eToro connection (#143) — admin only.
 *
 * PUT    /api/etoro/connections/:id
 *   Body: { apiKey, userKey } (replace the key, same eToro login) and/or { accountId }
 *   → 200 { connection } · 400 NOTHING_TO_UPDATE | CONNECTION_REMOVED | ETORO_WRITE_SCOPE
 *   → 409 ETORO_DIFFERENT_LOGIN · 422 ETORO_KEY_INVALID · 502 ETORO_UNAVAILABLE
 * DELETE /api/etoro/connections/:id
 *   → 204 — stops updates and wipes the keys; copies, values and holdings stay.
 *
 * Session only: /api/etoro is on INTEGRATION_DENYLIST.
 */

import { StatusCodes } from 'http-status-codes';
import { withAuth } from '../../../../utils/withAuth.js';
import { applyEtoroRateLimit, sendEtoroError } from '../../../../utils/etoroRoute.js';
import { removeConnection, updateConnection } from '../../../../services/etoro.service.js';

export const config = { api: { bodyParser: { sizeLimit: '8kb' } } };

export default withAuth(async function handler(req, res) {
  await applyEtoroRateLimit(req, res);
  const { tenantId } = req.user;
  const id = String(req.query.id);

  try {
    if (req.method === 'PUT') {
      return res.status(StatusCodes.OK).json({ connection: await updateConnection({ tenantId, id, body: req.body }) });
    }
    if (req.method === 'DELETE') {
      await removeConnection({ tenantId, id });
      return res.status(StatusCodes.NO_CONTENT).end();
    }
    res.setHeader('Allow', ['PUT', 'DELETE']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  } catch (error) {
    return sendEtoroError(res, error, 'connection');
  }
}, { requireRole: 'admin' });
