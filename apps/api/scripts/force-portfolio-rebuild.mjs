#!/usr/bin/env node

/**
 * Force a full portfolio rebuild for a tenant.
 *
 * Emits a TENANT_CURRENCY_SETTINGS_UPDATED event to the backend, which
 * triggers the full rebuild chain:
 *   portfolio sync → cash holdings → analytics → valuations + loans
 *
 * Usage:
 *   node scripts/force-portfolio-rebuild.mjs <tenantId>
 *   node scripts/force-portfolio-rebuild.mjs <tenantId> --dry-run
 *
 * Environment:
 *   BACKEND_URL       (default: http://localhost:3001)
 *   INTERNAL_API_KEY  (required)
 *   DATABASE_URL      (required — to verify tenant exists)
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const BACKEND_API_KEY = process.env.INTERNAL_API_KEY;

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const tenantId = args.find(a => a !== '--dry-run');

  if (!tenantId) {
    console.error('Usage: node scripts/force-portfolio-rebuild.mjs <tenantId> [--dry-run]');
    process.exit(1);
  }

  if (!BACKEND_API_KEY) {
    console.error('INTERNAL_API_KEY environment variable is required.');
    process.exit(1);
  }

  const id = tenantId;

  // Verify tenant exists and show summary
  const tenant = await prisma.tenant.findUnique({ where: { id } });
  if (!tenant) {
    console.error(`Tenant ${id} not found.`);
    process.exit(1);
  }

  const [txCount, portfolioCount, accountCount] = await Promise.all([
    prisma.transaction.count({ where: { tenantId: id } }),
    prisma.portfolioItem.count({ where: { tenantId: id } }),
    prisma.account.count({ where: { tenantId: id } }),
  ]);

  console.log(`\nTenant:          ${tenant.name} (id: ${id})`);
  console.log(`Accounts:        ${accountCount}`);
  console.log(`Transactions:    ${txCount}`);
  console.log(`Portfolio items: ${portfolioCount}`);
  console.log(`\nThis will trigger a FULL portfolio rebuild:`);
  console.log(`  1. Sync all transactions → portfolio items`);
  console.log(`  2. Rebuild all cash holdings`);
  console.log(`  3. Full analytics recalculation`);
  console.log(`  4. Revalue all assets + reprocess loans`);

  if (dryRun) {
    console.log('\n--dry-run: No event emitted.');
    return;
  }

  // Emit the event
  const event = { type: 'TENANT_CURRENCY_SETTINGS_UPDATED', tenantId: id };

  const response = await fetch(`${BACKEND_URL}/api/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': BACKEND_API_KEY,
    },
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error(`\nBackend returned ${response.status}: ${body}`);
    process.exit(1);
  }

  console.log(`\nEvent emitted successfully. Full rebuild is now queued.`);
}

main()
  .catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
