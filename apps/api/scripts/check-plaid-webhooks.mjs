#!/usr/bin/env node
/**
 * Compare the webhook URL Plaid has registered for each PlaidItem against the
 * API's PLAID_WEBHOOK_URL, and show when Plaid last sent a webhook.
 *
 * Talks to /api/admin/plaid-webhooks with the operator key, so it runs from
 * any machine without database or Plaid credentials (the Plaid calls need each
 * Item's access token, which only the API can decrypt). No dependencies.
 *
 * Usage:
 *   ADMIN_API_KEY=… node scripts/check-plaid-webhooks.mjs [--tenant <id>] [--fix] [--url <url>]
 *
 *   --fix   re-point every mismatched Item at PLAID_WEBHOOK_URL
 *           (/item/webhook/update). Read-only without it.
 *
 * API base URL: --url <url>, else BLISS_API_URL, else NEXTAUTH_URL, else
 * http://localhost:3000.
 */

const USAGE = `Usage:
  check-plaid-webhooks.mjs [--tenant <id>] [--fix] [--url <url>]

Environment:
  ADMIN_API_KEY   required; the same value the API server is configured with`;

function parseArgs(argv) {
  const opts = { fix: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tenant' || arg === '--url') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      opts[arg.slice(2)] = value;
      i += 1;
    } else if (arg === '--fix') {
      opts.fix = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printItem(item) {
  console.log(`── ${item.institutionName ?? '(unknown institution)'}  [${item.id}]`);
  console.log(`   tenant: ${item.tenantId}  status: ${item.status}`);
  console.log(`   Bliss lastSync:               ${item.lastSync ?? 'never'}`);
  if (item.registeredWebhook !== null || !item.error) {
    console.log(`   Plaid registered webhook:     ${item.registeredWebhook ?? '(none)'} ${item.matches ? '✓' : '✗ MISMATCH'}`);
    console.log(`   Plaid last webhook sent:      ${item.lastWebhookSentAt ?? 'never'}` +
      (item.lastWebhookCode ? ` (${item.lastWebhookCode})` : ''));
    console.log(`   Plaid last successful update: ${item.lastSuccessfulUpdate ?? 'never'}`);
    console.log(`   Plaid last failed update:     ${item.lastFailedUpdate ?? 'never'}`);
  }
  if (item.plaidItemError) console.log(`   Plaid item error:             ${item.plaidItemError}`);
  if (item.updated) console.log('   → webhook updated');
  if (item.error) console.log(`   ${item.error}`);
  console.log('');
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(1);
  }

  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    console.error(`ADMIN_API_KEY is required.\n\n${USAGE}`);
    process.exit(1);
  }

  const base = (opts.url || process.env.BLISS_API_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000')
    .replace(/\/+$/, '');
  const url = new URL(`${base}/api/admin/plaid-webhooks`);

  const init = { headers: { 'x-admin-key': adminKey } };
  if (opts.fix) {
    init.method = 'POST';
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.tenant ? { tenantId: opts.tenant } : {});
  } else if (opts.tenant) {
    url.searchParams.set('tenantId', opts.tenant);
  }

  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text };
  }
  if (!res.ok) {
    console.error(`${res.status} from ${url.origin}${url.pathname}: ${body.error ?? text}`);
    process.exit(1);
  }

  console.log(`PLAID_ENV:         ${body.plaidEnv}`);
  console.log(`PLAID_WEBHOOK_URL: ${body.expectedWebhook ?? '(not set on the API service)'}`);
  console.log('');

  if (body.items.length === 0) {
    console.log('No PlaidItems found.');
    return;
  }
  body.items.forEach(printItem);

  const updated = body.items.filter(i => i.updated).length;
  const mismatched = body.items.filter(i => !i.error && !i.matches && !i.updated).length;
  console.log(`${body.items.length} item(s), ${mismatched} with a webhook different from PLAID_WEBHOOK_URL` +
    (opts.fix ? `, ${updated} updated.` : '.'));
  if (mismatched > 0 && !opts.fix) console.log('Re-run with --fix to re-point them.');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
