/**
 * POST /api/etoro/convert-holding — switch an investment holding to Copy
 * Trading (#143, R8). Admins and members; viewers get 403.
 *
 * Body: { portfolioItemId, etoroUsername }
 * → 200 { portfolioItemId, symbol, categoryId, transactionsMoved }
 * → 400 PORTFOLIO_ITEM_REQUIRED | INVALID_USERNAME | ALREADY_COPY_TRADING | NOT_AN_INVESTMENT
 * → 404 NOT_FOUND · 409 COPY_HOLDING_EXISTS | COPY_TRADING_CATEGORY_MISSING
 *
 * In place: the holding keeps its id, transactions (amounts, dates), income
 * terms and manual values. Session only: /api/etoro is on INTEGRATION_DENYLIST.
 */

import { StatusCodes } from 'http-status-codes';
import { withAuth } from '../../../utils/withAuth.js';
import { applyEtoroRateLimit, sendEtoroError } from '../../../utils/etoroRoute.js';
import { convertHolding } from '../../../services/etoro.service.js';

export default withAuth(async function handler(req, res) {
  await applyEtoroRateLimit(req, res);

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }
  if (req.user.role === 'viewer') {
    return res.status(StatusCodes.FORBIDDEN).json({ error: 'Viewers cannot change holdings', code: 'FORBIDDEN' });
  }

  try {
    return res.status(StatusCodes.OK).json(await convertHolding({ tenantId: req.user.tenantId, body: req.body }));
  } catch (error) {
    return sendEtoroError(res, error, 'convert-holding');
  }
});
