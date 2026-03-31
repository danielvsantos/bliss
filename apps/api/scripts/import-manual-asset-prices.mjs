#!/usr/bin/env node

/**
 * Import manual asset prices from Data/manualasset.csv into ManualAssetValue.
 *
 * CSV columns (header row required):
 *   Date                 — MMM-YY (e.g. Jan-18, Feb-19)
 *   Portfolio Item Name  — matches PortfolioItem.symbol for the tenant
 *   value                — numeric (e.g. 6.16544761)
 *   curency              — ISO 4217 code (e.g. BRL, USD)
 *
 * After inserting, fires MANUAL_PORTFOLIO_PRICE_UPDATED events to the backend
 * so the valuation service recalculates affected portfolio items.
 *
 * Usage:
 *   node scripts/import-manual-asset-prices.mjs <tenantId>
 *   node scripts/import-manual-asset-prices.mjs <tenantId> --dry-run
 *   node scripts/import-manual-asset-prices.mjs <tenantId> --csv path/to/file.csv
 *
 * Environment:
 *   DATABASE_URL        (required)
 *   BACKEND_URL         (default: http://localhost:3001)
 *   INTERNAL_API_KEY    (required for event dispatch)
 */

import { PrismaClient } from '@prisma/client';
import Papa from 'papaparse';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const BACKEND_API_KEY = process.env.INTERNAL_API_KEY;

const DEFAULT_CSV = path.resolve(__dirname, '..', 'Data', 'manualasset.csv');

// ── Arg parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const csvIdx = args.indexOf('--csv');
const csvPath = csvIdx !== -1 ? args[csvIdx + 1] : DEFAULT_CSV;
const positional = args.filter((a, i) => !a.startsWith('--') && (csvIdx === -1 || i !== csvIdx + 1));

let tenantId = positional[0];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Parse "Jan-18" → Date (2018-01-01T00:00:00.000Z) */
function parseMonthYear(str) {
  const months = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const match = str.match(/^([A-Za-z]{3})-(\d{2})$/);
  if (!match) return null;
  const month = months[match[1]];
  if (month === undefined) return null;
  const year = 2000 + parseInt(match[2], 10);
  return new Date(Date.UTC(year, month, 1));
}

async function promptTenantId() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('Enter the tenant ID: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function fireEvent(event) {
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
    console.error(`  ⚠️  Event ${event.type} failed (${response.status}): ${body}`);
    return false;
  }
  return true;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Get tenant ID (interactive prompt if not provided)
  if (!tenantId) {
    tenantId = await promptTenantId();
  }

  if (!tenantId) {
    console.error('❌ Tenant ID is required.');
    process.exit(1);
  }

  // 2. Verify tenant exists
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    console.error(`❌ Tenant not found: ${tenantId}`);
    process.exit(1);
  }

  // 3. Verify CSV exists
  const resolvedCsv = path.resolve(csvPath);
  if (!fs.existsSync(resolvedCsv)) {
    console.error(`❌ CSV file not found: ${resolvedCsv}`);
    process.exit(1);
  }

  console.log(`\n📂 Importing manual asset prices for tenant "${tenant.name}" (${tenantId})`);
  console.log(`   CSV: ${path.basename(resolvedCsv)}`);
  if (dryRun) console.log('   (dry run — no changes will be made)');
  console.log();

  // 4. Parse CSV (handle BOM + Windows line endings)
  let raw = fs.readFileSync(resolvedCsv, 'utf-8');
  raw = raw.replace(/^\uFEFF/, '');           // strip BOM
  raw = raw.replace(/\r\n/g, '\n');           // normalize line endings

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

  console.log(`   ${data.length} rows parsed\n`);

  // 5. Build symbol → PortfolioItem map for this tenant
  const portfolioItems = await prisma.portfolioItem.findMany({
    where: { tenantId },
    select: { id: true, symbol: true },
  });
  const assetBySymbol = Object.fromEntries(portfolioItems.map(p => [p.symbol, p]));

  // Collect unique asset names from CSV to show mapping
  const uniqueAssets = [...new Set(data.map(r => (r['Portfolio Item Name'] || '').trim()).filter(Boolean))];
  console.log(`   Unique assets in CSV: ${uniqueAssets.join(', ')}`);

  const unmapped = uniqueAssets.filter(name => !assetBySymbol[name]);
  if (unmapped.length > 0) {
    console.error(`\n❌ The following assets have no matching PortfolioItem.symbol for this tenant:`);
    unmapped.forEach(name => console.error(`     - "${name}"`));
    console.error(`\n   Available symbols: ${portfolioItems.map(p => p.symbol).join(', ')}`);
    process.exit(1);
  }

  console.log(`   All assets matched to portfolio items ✅\n`);

  // 6. Process rows
  let created = 0, skipped = 0, failed = 0;
  const affectedPortfolioItemIds = new Set();

  console.log('── Rows ──────────────────────────────────────────────────');

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const rowNum = i + 2; // 1-indexed + header

    const assetName = (row['Portfolio Item Name'] || '').trim();
    const dateStr   = (row['Date'] || '').trim();
    const valueStr  = (row['value'] || '').trim();
    const currency  = (row['curency'] || '').trim();

    // Validate required fields
    if (!assetName || !dateStr || !valueStr || !currency) {
      console.log(`  ⚠️  Row ${rowNum}: missing required field — skipping`);
      failed++;
      continue;
    }

    // Parse date (MMM-YY format)
    const date = parseMonthYear(dateStr);
    if (!date) {
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

    const assetId = assetBySymbol[assetName].id;

    // Dedup: same asset + same date
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
      affectedPortfolioItemIds.add(assetId);
      created++;
      continue;
    }

    await prisma.manualAssetValue.create({
      data: { assetId, tenantId, date, value, currency },
    });
    console.log(`  ✅ ${dateStr} | ${assetName} | ${value} ${currency}`);
    affectedPortfolioItemIds.add(assetId);
    created++;
  }

  // 7. Summary
  console.log('\n─────────────────────────────────────────────────────────');
  console.log(`  ${dryRun ? 'Would create' : 'Created'} : ${created}`);
  console.log(`  Skipped  : ${skipped}`);
  console.log(`  Failed   : ${failed}`);

  // 8. Fire recalculation events
  if (affectedPortfolioItemIds.size > 0 && !dryRun) {
    if (!BACKEND_API_KEY) {
      console.warn('\n⚠️  INTERNAL_API_KEY not set — skipping event dispatch.');
      console.warn('   Run force-portfolio-rebuild.mjs manually to recalculate.');
    } else {
      console.log(`\n🔄 Firing recalculation events for ${affectedPortfolioItemIds.size} portfolio item(s)...`);

      for (const portfolioItemId of affectedPortfolioItemIds) {
        const ok = await fireEvent({
          type: 'MANUAL_PORTFOLIO_PRICE_UPDATED',
          portfolioItemId,
          tenantId,
        });
        if (ok) {
          console.log(`  ✅ Event fired for portfolioItemId=${portfolioItemId}`);
        }
      }

      console.log('   Events dispatched — valuation recalculation is now queued.');
    }
  } else if (dryRun && affectedPortfolioItemIds.size > 0) {
    console.log(`\n🔍 Would fire MANUAL_PORTFOLIO_PRICE_UPDATED for ${affectedPortfolioItemIds.size} portfolio item(s)`);
  }

  console.log(`\n✅ Done.\n`);
}

main()
  .catch(err => {
    console.error('\n❌ Script failed:', err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
