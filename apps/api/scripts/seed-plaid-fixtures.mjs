/**
 * Seed script: create throwaway Plaid fixture data (PlaidItem + PlaidTransaction
 * rows with encrypted rawJson) for rehearsing the ENCRYPTION_SECRET rotation
 * procedure (docs/guides/key-rotation.md §2, R6).
 *
 * PlaidTransaction.rawJson is NOT covered by prisma/seed.js — that script runs
 * on every container boot (including real self-hosted production instances)
 * and creates no tenant/user data at all. This script is standalone and
 * manually invoked only, matching seed-tenant-setup.mjs / seed-manual-asset-values.mjs.
 *
 * Usage:
 *   node scripts/seed-plaid-fixtures.mjs                    # creates a throwaway tenant/user
 *   node scripts/seed-plaid-fixtures.mjs --tenant <tenantId> # attaches to an existing tenant
 *   node scripts/seed-plaid-fixtures.mjs --count 25          # number of PlaidTransaction rows (default 10)
 */

import { PrismaClient } from '@prisma/client';
import { encrypt } from '@bliss/shared/encryption';

const prisma = new PrismaClient();

// ── Arg parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

const explicitTenantId = argValue('--tenant');
const count = Number(argValue('--count') ?? '10');

// ── Fixture builders (pure — no I/O, so they're unit-testable) ───────────────

/** Builds a fake raw Plaid transaction payload, shaped like the real API response. */
export function buildFakePlaidPayload(index) {
  return {
    transaction_id: `fixture-txn-${index}`,
    account_id: 'fixture-account-1',
    amount: Number((Math.random() * 200).toFixed(2)),
    date: new Date(Date.now() - index * 86400000).toISOString().slice(0, 10),
    name: `Fixture Merchant #${index}`,
    merchant_name: `Fixture Merchant #${index}`,
    payment_channel: 'online',
    iso_currency_code: 'USD',
    pending: false,
    personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_OTHER' },
  };
}

/**
 * Maps a fake Plaid payload to the PlaidTransaction create shape, mirroring
 * plaidSyncWorker.js's mapPlaidTransaction() — including the manual rawJson
 * encryption this script exists to exercise.
 */
export function buildFixturePlaidTransaction(plaidItemId, index) {
  const payload = buildFakePlaidPayload(index);
  return {
    plaidItemId,
    plaidAccountId: payload.account_id,
    plaidTransactionId: payload.transaction_id,
    amount: payload.amount,
    date: new Date(payload.date),
    name: payload.name,
    merchantName: payload.merchant_name,
    paymentChannel: payload.payment_channel,
    isoCurrencyCode: payload.iso_currency_code,
    pending: payload.pending,
    category: payload.personal_finance_category,
    syncType: 'ADDED',
    processed: false,
    rawJson: encrypt(JSON.stringify(payload)),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let tenantId = explicitTenantId;
  let userId;

  if (tenantId) {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      console.error(`❌ Tenant not found: ${tenantId}`);
      process.exit(1);
    }
    const existingUser = await prisma.user.findFirst({ where: { tenantId } });
    if (!existingUser) {
      console.error(`❌ Tenant ${tenantId} has no users — pass a tenant that already has one, or omit --tenant to create a throwaway one.`);
      process.exit(1);
    }
    userId = existingUser.id;
    console.log(`Using existing tenant "${tenant.name}" (${tenantId})`);
  } else {
    const suffix = Date.now();
    const tenant = await prisma.tenant.create({
      data: { name: `Key Rotation Rehearsal ${suffix}` },
    });
    tenantId = tenant.id;

    const email = `key-rotation-rehearsal-${suffix}@example.invalid`;
    const user = await prisma.user.create({
      data: {
        tenantId,
        email: encrypt(email, true),
        name: 'Key Rotation Rehearsal User',
        role: 'admin',
      },
    });
    userId = user.id;
    console.log(`✅ Created throwaway tenant "${tenant.name}" (${tenantId}) and user ${email} (${userId})`);
  }

  const plaidItem = await prisma.plaidItem.create({
    data: {
      tenantId,
      userId,
      itemId: `fixture-item-${Date.now()}`,
      accessToken: encrypt('access-sandbox-fixture-token'),
      institutionId: 'ins_fixture',
      institutionName: 'Fixture Bank',
      status: 'ACTIVE',
      environment: 'sandbox',
    },
  });
  console.log(`✅ Created PlaidItem ${plaidItem.id}`);

  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push(buildFixturePlaidTransaction(plaidItem.id, i));
  }
  await prisma.plaidTransaction.createMany({ data: rows });
  console.log(`✅ Created ${rows.length} PlaidTransaction rows with encrypted rawJson`);

  console.log('\nDone. Summary:');
  console.log(`  tenantId: ${tenantId}`);
  console.log(`  userId:   ${userId}`);
  console.log(`  plaidItemId: ${plaidItem.id}`);
  console.log(`  plaidTransactions: ${rows.length}`);
}

main()
  .catch((err) => {
    console.error('\n❌ Fixture seed failed:', err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
