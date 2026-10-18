/**
 * POST /api/enablebanking/connect
 * Body: { aspspName, aspspCountry, reconnectItemId? } → { url, startDate }
 *
 * Starts the PSD2 consent (#132, R2): POST /auth with valid_until = now + the
 * bank's maximum consent − 1 day, psu_type 'personal', the registered callback
 * URL and a signed single-use state. The browser then navigates to `url`.
 * A reconnect (R7) must target a connection of this tenant authorised by the
 * caller; its bank comes from the connection, not the body.
 */

import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../prisma/prisma';
import { withAuth } from '../../../utils/withAuth.js';
import {
  PROVIDER,
  applyRateLimit,
  consentValidUntil,
  getCallbackUrl,
  getTenantEnableBanking,
  notEnabled,
  signState,
} from '../../../utils/enableBanking.js';
import { syncCutoffDate, syncDateFrom, isoDate } from '@bliss/shared/enablebanking';

export default withAuth(async function handler(req, res) {
  await applyRateLimit(req, res);

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  const user = req.user;
  const { aspspName, aspspCountry, reconnectItemId } = req.body || {};

  try {
    const eb = await getTenantEnableBanking(user.tenantId);
    if (!eb) return notEnabled(res);

    const tenant = await prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { plaidHistoryDays: true },
    });
    const historyDays = tenant?.plaidHistoryDays ?? 1;

    let name;
    let country;
    let startDate;
    if (reconnectItemId) {
      const item = await prisma.plaidItem.findFirst({
        where: { id: String(reconnectItemId), tenantId: user.tenantId, provider: PROVIDER },
        select: { id: true, userId: true, institutionName: true, aspspCountry: true, createdAt: true, lastSync: true },
      });
      if (!item) {
        return res.status(StatusCodes.NOT_FOUND).json({ error: 'Connection not found' });
      }
      if (item.userId !== user.id) {
        return res.status(StatusCodes.FORBIDDEN).json({
          error: 'Only the person who authorised this connection can reconnect it',
          code: 'NOT_AUTHORISING_USER',
        });
      }
      name = item.institutionName;
      country = item.aspspCountry;
      startDate = syncDateFrom({ createdAt: item.createdAt, historyDays, lastSync: item.lastSync });
    } else {
      if (typeof aspspName !== 'string' || !aspspName.trim() || typeof aspspCountry !== 'string' || !/^[A-Z]{2}$/.test(aspspCountry)) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'aspspName and a 2-letter aspspCountry are required' });
      }
      const enabledCountry = await prisma.tenantCountry.findFirst({
        where: { tenantId: user.tenantId, country: { iso2: aspspCountry } },
        select: { countryId: true },
      });
      if (!enabledCountry) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Country is not enabled for this workspace', code: 'COUNTRY_NOT_ENABLED' });
      }
      name = aspspName.trim();
      country = aspspCountry;
      startDate = syncCutoffDate(new Date(), historyDays);
    }

    const { client } = eb;
    const aspsp = (await client.getAspsps(country)).find((a) => a.name === name);
    if (!aspsp) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Unknown bank', code: 'UNKNOWN_ASPSP' });
    }

    let state;
    try {
      state = await signState({ tenantId: user.tenantId, userId: user.id, reconnectItemId: reconnectItemId || null });
    } catch (err) {
      console.error('[enablebanking/connect] cannot sign state:', err.message);
      return res.status(StatusCodes.SERVICE_UNAVAILABLE).json({ error: 'Bank connections are temporarily unavailable' });
    }

    const auth = await client.startAuth({
      access: { valid_until: consentValidUntil(aspsp.maximum_consent_validity).toISOString() },
      aspsp: { name: aspsp.name, country: aspsp.country },
      state,
      redirect_url: getCallbackUrl(),
      psu_type: 'personal',
    });

    return res.status(StatusCodes.OK).json({ url: auth.url, startDate: isoDate(startDate) });
  } catch (error) {
    Sentry.captureException(error);
    console.error('[enablebanking/connect] failed:', error.message);
    return res.status(StatusCodes.BAD_GATEWAY).json({ error: 'Could not start the bank connection' });
  }
});
