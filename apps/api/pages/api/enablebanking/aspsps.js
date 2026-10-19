/**
 * GET /api/enablebanking/aspsps
 *
 * Banks available through Enable Banking in the tenant's countries (#132, R2),
 * plus the start date a new connection's first sync would use.
 * → { aspsps: [{ name, country, logo, maximumConsentValiditySec }], startDate }
 */

import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../prisma/prisma';
import { withAuth } from '../../../utils/withAuth.js';
import {
  applyRateLimit,
  getTenantEnableBanking,
  notEnabled,
} from '../../../utils/enableBanking.js';
import { syncCutoffDate, isoDate } from '@bliss/shared/enablebanking';

export default withAuth(async function handler(req, res) {
  await applyRateLimit(req, res);

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }
  if (req.user.role === 'viewer') {
    return res.status(StatusCodes.FORBIDDEN).json({ error: 'Viewers cannot connect banks' });
  }

  try {
    const eb = await getTenantEnableBanking(req.user.tenantId);
    if (!eb) return notEnabled(res);

    const [countries, tenant] = await Promise.all([
      prisma.tenantCountry.findMany({
        where: { tenantId: req.user.tenantId },
        select: { country: { select: { iso2: true } } },
      }),
      prisma.tenant.findUnique({ where: { id: req.user.tenantId }, select: { plaidHistoryDays: true } }),
    ]);
    const isoCodes = [...new Set(countries.map((c) => c.country?.iso2).filter(Boolean))];

    const lists = await Promise.all(isoCodes.map((code) => eb.client.getAspsps(code)));
    const aspsps = lists.flat().map((a) => ({
      name: a.name,
      country: a.country,
      logo: a.logo || null,
      maximumConsentValiditySec: a.maximum_consent_validity ?? null,
    })).sort((a, b) => a.country.localeCompare(b.country) || a.name.localeCompare(b.name));

    return res.status(StatusCodes.OK).json({
      aspsps,
      startDate: isoDate(syncCutoffDate(new Date(), tenant?.plaidHistoryDays ?? 1)),
    });
  } catch (error) {
    Sentry.captureException(error);
    console.error('[enablebanking/aspsps] failed:', error.message);
    return res.status(StatusCodes.BAD_GATEWAY).json({ error: 'Could not load the bank list' });
  }
});
