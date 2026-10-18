/**
 * GET /api/enablebanking/status → { enabled, configurable, pausedConnections }
 *
 * Every role. Enable Banking is per tenant (#148): `enabled` is true when the
 * tenant has saved credentials (any validation status); the web app hides
 * every Enable Banking entry point otherwise. `configurable` tells the caller
 * whether they may set the credentials up (admins), and `pausedConnections`
 * counts the tenant's connections waiting for credentials (0 when enabled).
 */

import { StatusCodes } from 'http-status-codes';
import prisma from '../../../prisma/prisma';
import { withAuth } from '../../../utils/withAuth.js';
import { PROVIDER, applyRateLimit } from '../../../utils/enableBanking.js';

export default withAuth(async function handler(req, res) {
  await applyRateLimit(req, res);

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  const { tenantId, role } = req.user;
  const credential = await prisma.enableBankingCredential.findUnique({ where: { tenantId }, select: { id: true } });
  const pausedConnections = credential ? 0 : await prisma.plaidItem.count({
    where: { tenantId, provider: PROVIDER, status: { not: 'REVOKED' } },
  });

  return res.status(StatusCodes.OK).json({
    enabled: Boolean(credential),
    configurable: role === 'admin',
    pausedConnections,
  });
});
