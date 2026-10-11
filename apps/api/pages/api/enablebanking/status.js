/**
 * GET /api/enablebanking/status → { enabled }
 *
 * Enable Banking (#132) is optional: `enabled` is false when
 * ENABLE_BANKING_APP_ID or the private key is not configured, and the web app
 * then hides every Enable Banking entry point.
 */

import { StatusCodes } from 'http-status-codes';
import { withAuth } from '../../../utils/withAuth.js';
import { applyRateLimit, isEnableBankingEnabled } from '../../../utils/enableBanking.js';

export default withAuth(async function handler(req, res) {
  await applyRateLimit(req, res);

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  return res.status(StatusCodes.OK).json({ enabled: isEnableBankingEnabled() });
});
