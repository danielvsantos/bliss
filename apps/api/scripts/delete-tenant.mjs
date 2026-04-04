/**
 * Admin script: delete a tenant and all its data.
 *
 * Usage:
 *   node scripts/delete-tenant.mjs --dry-run <tenantId>   # preview only, no changes
 *   node scripts/delete-tenant.mjs <tenantId>             # interactive deletion
 *
 * Bypasses the HTTP layer entirely — connects to the DB via DATABASE_URL
 * from the local .env file and replicates the same ordered deletion logic
 * used by DELETE /api/tenants.
 */

import { PrismaClient } from '@prisma/client';
import * as readline from 'readline';

const prisma = new PrismaClient();

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const tenantId = args.find(a => !a.startsWith('--'));

if (!tenantId) {
  console.error('Usage:');
  console.error('  node scripts/delete-tenant.mjs --dry-run <tenantId>');
  console.error('  node scripts/delete-tenant.mjs <tenantId>');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function fmt(n) {
  return String(n).padStart(8);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Verify tenant exists
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    include: { users: { select: { email: true }, take: 1 } },
  });

  if (!tenant) {
    console.error(`❌ Tenant not found: ${tenantId}`);
    process.exit(1);
  }

  const ownerEmail = tenant.users[0]?.email ?? '(no users)';
  console.log('\n── Tenant ───────────────────────────────────────────────');
  console.log(`  ID:      ${tenant.id}`);
  console.log(`  Name:    ${tenant.name}`);
  console.log(`  Plan:    ${tenant.plan}`);
  console.log(`  Owner:   ${ownerEmail}`);
  console.log(`  Created: ${tenant.createdAt.toISOString()}`);
  console.log('─────────────────────────────────────────────────────────\n');

  // 2. Count everything that will be deleted
  const [
    userCount,
    accountCount,
    transactionCount,
    categoryCount,
    portfolioItemCount,
    plaidItemCount,
    plaidTransactionCount,
    tagCount,
    analyticsCacheMonthlyCount,
    stagedImportCount,
    importAdapterCount,
    embeddingCount,
    insightCount,
  ] = await Promise.all([
    prisma.user.count({ where: { tenantId } }),
    prisma.account.count({ where: { tenantId } }),
    prisma.transaction.count({ where: { tenantId } }),
    prisma.category.count({ where: { tenantId } }),
    prisma.portfolioItem.count({ where: { tenantId } }),
    prisma.plaidItem.count({ where: { tenantId } }),
    prisma.plaidTransaction.count({ where: { plaidItem: { tenantId } } }),
    prisma.tag.count({ where: { tenantId } }),
    prisma.analyticsCacheMonthly.count({ where: { tenantId } }),
    prisma.stagedImport.count({ where: { tenantId } }),
    prisma.importAdapter.count({ where: { tenantId } }),
    prisma.transactionEmbedding.count({ where: { tenantId } }),
    prisma.insight.count({ where: { tenantId } }),
  ]);

  const total =
    userCount + accountCount + transactionCount + categoryCount +
    portfolioItemCount + plaidItemCount + plaidTransactionCount + tagCount +
    analyticsCacheMonthlyCount +
    stagedImportCount + importAdapterCount +
    embeddingCount + insightCount + 1; // +1 for the Tenant itself

  console.log('── Records that will be permanently deleted ─────────────');
  console.log(`  Users                   ${fmt(userCount)}`);
  console.log(`  Accounts                ${fmt(accountCount)}`);
  console.log(`  Transactions            ${fmt(transactionCount)}`);
  console.log(`  Categories              ${fmt(categoryCount)}`);
  console.log(`  Portfolio Items         ${fmt(portfolioItemCount)}`);
  console.log(`  Plaid Items             ${fmt(plaidItemCount)}`);
  console.log(`  Plaid Transactions      ${fmt(plaidTransactionCount)}`);
  console.log(`  Tags                    ${fmt(tagCount)}`);
  console.log(`  Analytics Cache (mo.)   ${fmt(analyticsCacheMonthlyCount)}`);
  console.log(`  Staged Imports          ${fmt(stagedImportCount)}`);
  console.log(`  Import Adapters         ${fmt(importAdapterCount)}`);
  console.log(`  Embeddings              ${fmt(embeddingCount)}`);
  console.log(`  Insights                ${fmt(insightCount)}`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  Total                   ${fmt(total)}`);
  console.log('─────────────────────────────────────────────────────────\n');

  if (dryRun) {
    console.log('✅ Dry run complete — no changes were made.\n');
    return;
  }

  // 3. Interactive confirmation
  console.log('⚠️  This operation is IRREVERSIBLE. All data listed above will be permanently deleted.');
  const answer = await prompt(`\nType the tenant ID to confirm deletion, or press Ctrl+C to abort:\n> `);

  if (answer !== tenantId) {
    console.log('\n❌ Confirmation did not match. Aborting.\n');
    process.exit(1);
  }

  // 4. Perform deletion sequentially (no transaction wrapper — Prisma Accelerate
  //    caps interactive transactions at 15 s which is too short for large tenants).
  //    The order is the same as the API handler to respect FK constraints.
  //    This is safe for an admin script: if it fails midway, re-running it will
  //    skip already-deleted rows and continue from where it left off.
  console.log('\n🗑️  Deleting...');
  const start = Date.now();

  const step = (label) => process.stdout.write(`  ${label}...`);
  const done = (n) => console.log(` ${n} deleted`);

  // Collect IDs needed for join-table deletes
  const accounts = await prisma.account.findMany({ where: { tenantId }, select: { id: true } });
  const accountIds = accounts.map(a => a.id);

  const portfolioItems = await prisma.portfolioItem.findMany({ where: { tenantId }, select: { id: true } });
  const portfolioItemIds = portfolioItems.map(p => p.id);

  // Join tables with FKs to Account / PortfolioItem
  if (accountIds.length > 0) {
    step('AccountOwner');
    const r = await prisma.accountOwner.deleteMany({ where: { accountId: { in: accountIds } } });
    done(r.count);
  }
  if (portfolioItemIds.length > 0) {
    step('DebtTerms');
    const r1 = await prisma.debtTerms.deleteMany({ where: { assetId: { in: portfolioItemIds } } });
    done(r1.count);
    step('PortfolioHolding');
    const r2 = await prisma.portfolioHolding.deleteMany({ where: { portfolioItemId: { in: portfolioItemIds } } });
    done(r2.count);
    step('PortfolioValueHistory');
    const r3 = await prisma.portfolioValueHistory.deleteMany({ where: { assetId: { in: portfolioItemIds } } });
    done(r3.count);
    // ManualAssetValue cascades from PortfolioItem
  }

  // AI / import data
  step('TransactionEmbedding');
  const emb = await prisma.transactionEmbedding.deleteMany({ where: { tenantId } });
  done(emb.count);

  step('StagedImport'); // StagedImportRow cascades
  const si = await prisma.stagedImport.deleteMany({ where: { tenantId } });
  done(si.count);

  step('ImportAdapter');
  const ia = await prisma.importAdapter.deleteMany({ where: { tenantId } });
  done(ia.count);

  // TransactionTags must go before Transactions
  const tags = await prisma.tag.findMany({ where: { tenantId }, select: { id: true } });
  const tagIds = tags.map(t => t.id);
  if (tagIds.length > 0) {
    step('TransactionTag');
    const r = await prisma.transactionTag.deleteMany({ where: { tagId: { in: tagIds } } });
    done(r.count);
  }

  step('Transaction');
  const txns = await prisma.transaction.deleteMany({ where: { tenantId } });
  done(txns.count);

  step('Tag');
  const tg = await prisma.tag.deleteMany({ where: { tenantId } });
  done(tg.count);

  // PortfolioItem before Category
  step('PortfolioItem');
  const pi = await prisma.portfolioItem.deleteMany({ where: { tenantId } });
  done(pi.count);

  step('Account');
  const ac = await prisma.account.deleteMany({ where: { tenantId } });
  done(ac.count);

  step('Category');
  const cat = await prisma.category.deleteMany({ where: { tenantId } });
  done(cat.count);

  // Analytics, insights, audit logs
  step('AnalyticsCacheMonthly');
  const anl = await prisma.analyticsCacheMonthly.deleteMany({ where: { tenantId } });
  done(anl.count);

  step('Insight');
  const ins = await prisma.insight.deleteMany({ where: { tenantId } });
  done(ins.count);

  // Tenant relations
  step('TenantCountry');
  const tc = await prisma.tenantCountry.deleteMany({ where: { tenantId } });
  done(tc.count);

  step('TenantCurrency');
  const tcu = await prisma.tenantCurrency.deleteMany({ where: { tenantId } });
  done(tcu.count);

  step('TenantBank');
  const tb = await prisma.tenantBank.deleteMany({ where: { tenantId } });
  done(tb.count);

  // Plaid (PlaidTransaction cascades from PlaidItem)
  step('PlaidItem');
  const pli = await prisma.plaidItem.deleteMany({ where: { tenantId } });
  done(pli.count);

  // Users
  step('User');
  const usr = await prisma.user.deleteMany({ where: { tenantId } });
  done(usr.count);

  // Finally, the tenant itself
  step('Tenant');
  await prisma.tenant.delete({ where: { id: tenantId } });
  done(1);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n✅ Tenant "${tenant.name}" (${tenantId}) and all associated data deleted in ${elapsed}s.\n`);
}

main()
  .catch(err => {
    console.error('\n❌ Deletion failed:', err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
