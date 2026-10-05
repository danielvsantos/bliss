#!/usr/bin/env node

/**
 * Compare the webhook URL Plaid has registered for each PlaidItem against
 * PLAID_WEBHOOK_URL, and show when Plaid last sent a webhook.
 *
 * Plaid stores the webhook per Item at link time (create-link-token.js), so
 * changing PLAID_WEBHOOK_URL later never reaches Items linked before it.
 * Read-only by default; `--fix` calls /item/webhook/update for every Item
 * whose registered URL differs from PLAID_WEBHOOK_URL.
 *
 * Usage:
 *   node scripts/check-plaid-webhooks.mjs [tenantId] [--fix]
 *
 * Environment (same values as the running API):
 *   DATABASE_URL, ENCRYPTION_SECRET, PLAID_CLIENT_ID, PLAID_SECRET,
 *   PLAID_ENV, PLAID_WEBHOOK_URL
 */

import { PrismaClient } from '@prisma/client';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { decrypt } from '@bliss/shared/encryption';

const prisma = new PrismaClient();

const PLAID_ENV = process.env.PLAID_ENV || 'sandbox';
const EXPECTED = process.env.PLAID_WEBHOOK_URL || null;

const plaidClient = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
}));

function plaidError(err) {
  const data = err?.response?.data;
  return data ? `${data.error_code}: ${data.error_message}` : err.message;
}

async function main() {
  const args = process.argv.slice(2);
  const fix = args.includes('--fix');
  const tenantId = args.find(a => !a.startsWith('--'));

  console.log(`PLAID_ENV:         ${PLAID_ENV}`);
  console.log(`PLAID_WEBHOOK_URL: ${EXPECTED ?? '(not set)'}`);
  console.log('');

  const items = await prisma.plaidItem.findMany({
    where: tenantId ? { tenantId } : {},
    select: {
      id: true, tenantId: true, itemId: true, accessToken: true,
      institutionName: true, status: true, lastSync: true, environment: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  if (items.length === 0) {
    console.log('No PlaidItems found.');
    return;
  }

  let mismatched = 0;

  for (const item of items) {
    console.log(`── ${item.institutionName ?? '(unknown institution)'}  [${item.id}]`);
    console.log(`   tenant: ${item.tenantId}  status: ${item.status}  env: ${item.environment ?? '?'}`);
    console.log(`   Bliss lastSync:              ${item.lastSync?.toISOString() ?? 'never'}`);

    let plaidItem;
    let plaidStatus;
    try {
      const res = await plaidClient.itemGet({ access_token: decrypt(item.accessToken) });
      plaidItem = res.data.item;
      plaidStatus = res.data.status;
    } catch (err) {
      console.log(`   /item/get failed — ${plaidError(err)}`);
      console.log('');
      continue;
    }

    const registered = plaidItem.webhook || null;
    const matches = registered === EXPECTED;
    console.log(`   Plaid registered webhook:    ${registered ?? '(none)'} ${matches ? '✓' : '✗ MISMATCH'}`);
    console.log(`   Plaid last webhook sent:     ${plaidStatus?.last_webhook?.sent_at ?? 'never'}` +
      (plaidStatus?.last_webhook?.code_sent ? ` (${plaidStatus.last_webhook.code_sent})` : ''));
    console.log(`   Plaid last successful update: ${plaidStatus?.transactions?.last_successful_update ?? 'never'}`);
    console.log(`   Plaid last failed update:     ${plaidStatus?.transactions?.last_failed_update ?? 'never'}`);
    if (plaidItem.error) {
      console.log(`   Plaid item error:            ${plaidItem.error.error_code}: ${plaidItem.error.error_message}`);
    }

    if (!matches) {
      mismatched += 1;
      if (fix && EXPECTED) {
        try {
          await plaidClient.itemWebhookUpdate({
            access_token: decrypt(item.accessToken),
            webhook: EXPECTED,
          });
          console.log(`   → webhook updated to ${EXPECTED}`);
        } catch (err) {
          console.log(`   → /item/webhook/update failed — ${plaidError(err)}`);
        }
      }
    }
    console.log('');
  }

  console.log(`${items.length} item(s), ${mismatched} with a webhook different from PLAID_WEBHOOK_URL.`);
  if (mismatched > 0 && !fix) {
    console.log('Re-run with --fix to call /item/webhook/update for them.');
  }
  if (mismatched > 0 && fix && !EXPECTED) {
    console.log('--fix skipped: PLAID_WEBHOOK_URL is not set.');
  }
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
