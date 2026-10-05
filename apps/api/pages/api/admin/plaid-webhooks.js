/**
 * /api/admin/plaid-webhooks — operator check of the webhook URL Plaid has
 * registered for each PlaidItem.
 *
 *   GET  ?tenantId=           → 200 { plaidEnv, expectedWebhook, items: [...] }
 *   POST { tenantId? }        → 200 same report; every Item whose registered
 *                               webhook differs from PLAID_WEBHOOK_URL is
 *                               re-pointed with /item/webhook/update
 *                               (400 when PLAID_WEBHOOK_URL is unset)
 *
 * Plaid stores the webhook per Item when it is linked (create-link-token.js),
 * so a later change to PLAID_WEBHOOK_URL never reaches existing Items. The
 * Plaid calls need each Item's access token, which only exists (encrypted) in
 * the database — hence a server-side route rather than a client script.
 *
 * Auth: x-admin-key header (ADMIN_API_KEY env var), failing closed when the key
 * is unset. Integration tokens are refused earlier by the central denylist.
 * Access tokens are never returned or logged.
 */

import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../utils/cors.js';
import { isAdminAuthorized } from '../../../utils/adminAuth.js';
import { plaidClient } from '../../../services/plaid.service.js';
import prisma from '../../../prisma/prisma.js';

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function plaidErrorMessage(error) {
  const data = error?.response?.data;
  return data?.error_code ? `${data.error_code}: ${data.error_message}` : error?.message ?? 'Unknown error';
}

async function inspectItem(item, expectedWebhook, fix) {
  const report = {
    id: item.id,
    tenantId: item.tenantId,
    institutionName: item.institutionName,
    status: item.status,
    lastSync: item.lastSync,
    registeredWebhook: null,
    matches: false,
    lastWebhookSentAt: null,
    lastWebhookCode: null,
    lastSuccessfulUpdate: null,
    lastFailedUpdate: null,
    plaidItemError: null,
    updated: false,
    error: null,
  };

  try {
    const { data } = await plaidClient.itemGet({ access_token: item.accessToken });
    report.registeredWebhook = data.item?.webhook || null;
    report.matches = report.registeredWebhook === expectedWebhook;
    report.lastWebhookSentAt = data.status?.last_webhook?.sent_at ?? null;
    report.lastWebhookCode = data.status?.last_webhook?.code_sent ?? null;
    report.lastSuccessfulUpdate = data.status?.transactions?.last_successful_update ?? null;
    report.lastFailedUpdate = data.status?.transactions?.last_failed_update ?? null;
    if (data.item?.error) {
      report.plaidItemError = `${data.item.error.error_code}: ${data.item.error.error_message}`;
    }
  } catch (error) {
    report.error = `/item/get failed — ${plaidErrorMessage(error)}`;
    return report;
  }

  if (fix && !report.matches) {
    try {
      await plaidClient.itemWebhookUpdate({ access_token: item.accessToken, webhook: expectedWebhook });
      report.updated = true;
    } catch (error) {
      report.error = `/item/webhook/update failed — ${plaidErrorMessage(error)}`;
    }
  }

  return report;
}

async function buildReport(tenantId, fix) {
  const expectedWebhook = process.env.PLAID_WEBHOOK_URL || null;

  const items = await prisma.plaidItem.findMany({
    where: tenantId ? { tenantId } : {},
    select: {
      id: true,
      tenantId: true,
      accessToken: true,
      institutionName: true,
      status: true,
      lastSync: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  // Sequential: a handful of Items per deployment, and it keeps us well clear
  // of Plaid's per-client rate limits.
  const reports = [];
  for (const item of items) {
    reports.push(await inspectItem(item, expectedWebhook, fix));
  }

  return {
    plaidEnv: process.env.PLAID_ENV || 'sandbox',
    expectedWebhook,
    items: reports,
  };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;

  if (!isAdminAuthorized(req, 'admin/plaid-webhooks')) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' });
  }

  try {
    switch (req.method) {
      case 'GET': {
        const tenantId = firstQueryValue(req.query?.tenantId);
        return res.status(StatusCodes.OK).json(await buildReport(tenantId ? String(tenantId) : null, false));
      }
      case 'POST': {
        if (!process.env.PLAID_WEBHOOK_URL) {
          return res
            .status(StatusCodes.BAD_REQUEST)
            .json({ error: 'PLAID_WEBHOOK_URL is not set on the API service' });
        }
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const tenantId = body.tenantId ? String(body.tenantId) : null;
        return res.status(StatusCodes.OK).json(await buildReport(tenantId, true));
      }
      default:
        res.setHeader('Allow', ['GET', 'POST']);
        return res.status(StatusCodes.METHOD_NOT_ALLOWED).end(`Method ${req.method} Not Allowed`);
    }
  } catch (error) {
    console.error('admin/plaid-webhooks error:', error?.message);
    Sentry.captureException(error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Internal server error' });
  }
}
