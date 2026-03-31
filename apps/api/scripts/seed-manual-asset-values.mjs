/**
 * Seed script: populate ManualAssetValue rows for a tenant from a CSV file.
 *
 * CSV columns (header row required):
 *   Date        — YYYY-MM-DD
 *   Currency    — ISO 4217 code (e.g. USD, EUR, BRL)
 *   Asset       — matches PortfolioItem.symbol for this tenant
 *   Notes       — optional free text
 *   Value       — numeric (e.g. 12345.67)
 *
 * Usage:
 *   node scripts/seed-manual-asset-values.mjs <tenantId> <path/to/file.csv>
 *   node scripts/seed-manual-asset-values.mjs --dry-run <tenantId> <path/to/file.csv>
 *
 * Idempotent — rows with the same asset + date are skipped if they already exist.
 */

import { PrismaClient } from '@prisma/client';
import Papa from 'papaparse';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

// ── Arg parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const positional = args.filter(a => !a.startsWith('--'));
const [tenantId, csvPath] = positional;

if (!tenantId || !csvPath) {
  console.error('Usage:');
  console.error('  node scripts/seed-manual-asset-values.mjs <tenantId> <path/to/file.csv>');
  console.error('  node scripts/seed-manual-asset-values.mjs --dry-run <tenantId> <path/to/file.csv>');
  process.exit(1);
}

const resolvedPath = path.resolve(csvPath);
if (!fs.existsSync(resolvedPath)) {
  console.error(`❌ File not found: ${resolvedPath}`);
  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Verify tenant
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    console.error(`❌ Tenant not found: ${tenantId}`);
    process.exit(1);
  }

  console.log(`\n📂 Seeding manual asset values for tenant "${tenant.name}" (${tenantId})`);
  if (dryRun) console.log('   (dry run — no changes will be made)');
  console.log();

  // 2. Parse CSV
  const raw = fs.readFileSync(resolvedPath, 'utf-8');
  const { data, errors } = Papa.parse(raw, {
    header: true,
    skipEmptyLines: true,
    transformHeader: h => h.trim(),
  });

  if (errors.length > 0) {
    console.error('❌ CSV parse errors:');
    errors.forEach(e => console.error(`   Row ${e.row}: ${e.message}`));
    process.exit(1);
  }

  console.log(`   ${data.length} rows parsed from ${path.basename(resolvedPath)}\n`);

  // 3. Cache portfolio items for this tenant (symbol → id)
  const portfolioItems = await prisma.portfolioItem.findMany({
    where: { tenantId },
    select: { id: true, symbol: true },
  });
  const assetIdBySymbol = Object.fromEntries(portfolioItems.map(p => [p.symbol, p.id]));

  // 4. Process rows
  let created = 0, skipped = 0, failed = 0;

  console.log('── Rows ──────────────────────────────────────────────────');

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const rowNum = i + 2; // 1-indexed + header

    const assetName = row['Asset']?.trim();
    const dateStr   = row['Date']?.trim();
    const currency  = row['Currency']?.trim();
    const valueStr  = row['Value']?.trim();
    const notes     = row['Notes']?.trim() || null;

    // Validate required fields
    if (!assetName || !dateStr || !currency || !valueStr) {
      console.log(`  ⚠️  Row ${rowNum}: missing required field — skipping`);
      failed++;
      continue;
    }

    // Parse date
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      console.log(`  ⚠️  Row ${rowNum}: invalid date "${dateStr}" — skipping`);
      failed++;
      continue;
    }

    // Parse value
    const value = parseFloat(valueStr.replace(/,/g, ''));
    if (isNaN(value)) {
      console.log(`  ⚠️  Row ${rowNum}: invalid value "${valueStr}" — skipping`);
      failed++;
      continue;
    }

    // Resolve asset
    const assetId = assetIdBySymbol[assetName];
    if (!assetId) {
      console.log(`  ⚠️  Row ${rowNum}: no PortfolioItem found with symbol "${assetName}" — skipping`);
      failed++;
      continue;
    }

    // Dedup check: same asset + same date
    const existing = await prisma.manualAssetValue.findFirst({
      where: { assetId, date },
    });

    if (existing) {
      console.log(`  ⏭️  ${dateStr} | ${assetName} | ${value} ${currency} — already exists`);
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`  🔍 ${dateStr} | ${assetName} | ${value} ${currency} — would create`);
      created++;
      continue;
    }

    await prisma.manualAssetValue.create({
      data: { assetId, tenantId, date, value, currency, notes },
    });
    console.log(`  ✅ ${dateStr} | ${assetName} | ${value} ${currency}`);
    created++;
  }

  // 5. Summary
  console.log('\n─────────────────────────────────────────────────────────');
  console.log(`  ${dryRun ? 'Would create' : 'Created'} : ${created}`);
  console.log(`  Skipped  : ${skipped}`);
  console.log(`  Failed   : ${failed}`);
  console.log(`\n✅ Done.\n`);
}

main()
  .catch(err => {
    console.error('\n❌ Script failed:', err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
