#!/usr/bin/env node

/**
 * cleanup-asset-prices.js
 *
 * Deletes AssetPrice records for a specific symbol (and optionally exchange).
 * Useful for clearing stale/bad price data so the valuation worker re-fetches.
 *
 * Usage:
 *   node scripts/cleanup-asset-prices.js CSAN3                    # dry run
 *   node scripts/cleanup-asset-prices.js CSAN3 --delete           # delete all for CSAN3
 *   node scripts/cleanup-asset-prices.js CSAN3 --exchange=BVMF    # only BVMF records
 *   node scripts/cleanup-asset-prices.js CSAN3 --no-data-only     # only noData sentinels
 *   node scripts/cleanup-asset-prices.js CSAN3 --delete --no-data-only --exchange=Bovespa
 */

import prisma from '../prisma/prisma.js';

const BATCH_SIZE = 10000;

function usage() {
  console.log(`
Usage: node scripts/cleanup-asset-prices.js <SYMBOL> [options]

Options:
  --delete          Actually delete (default is dry run)
  --exchange=XXX    Only records with this exchange value
  --no-data-only    Only records where noData = true
  --help            Show this help
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) {
    usage();
    return;
  }

  const symbol = args.find(a => !a.startsWith('--'));
  if (!symbol) {
    console.error('Error: symbol is required.\n');
    usage();
    process.exit(1);
  }

  const shouldDelete = args.includes('--delete');
  const noDataOnly = args.includes('--no-data-only');
  const exchangeArg = args.find(a => a.startsWith('--exchange='));
  const exchange = exchangeArg ? exchangeArg.split('=')[1] : undefined;

  const where = { symbol };
  if (exchange !== undefined) where.exchange = exchange;
  if (noDataOnly) where.noData = true;

  console.log(`=== AssetPrice Cleanup for ${symbol} ===\n`);
  console.log(`Filters: ${JSON.stringify(where)}\n`);

  // Summary by exchange + noData
  const groups = await prisma.assetPrice.groupBy({
    by: ['exchange', 'noData'],
    where,
    _count: true,
    _min: { day: true },
    _max: { day: true },
  });

  if (groups.length === 0) {
    console.log('No matching AssetPrice records found.\n');
    return;
  }

  let total = 0;
  console.log(`  ${'Exchange'.padEnd(15)} ${'noData'.padEnd(8)} ${'Count'.padEnd(8)} Date Range`);
  console.log(`  ${'─'.repeat(15)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(25)}`);

  for (const g of groups) {
    const minDay = g._min.day?.toISOString().split('T')[0] ?? '?';
    const maxDay = g._max.day?.toISOString().split('T')[0] ?? '?';
    const exch = (g.exchange || '(empty)').padEnd(15);
    console.log(`  ${exch} ${String(g.noData ?? false).padEnd(8)} ${String(g._count).padEnd(8)} ${minDay} → ${maxDay}`);
    total += g._count;
  }
  console.log(`\n  Total: ${total} record(s)\n`);

  if (!shouldDelete) {
    console.log(`Dry run — no records deleted. Run with --delete to remove ${total} record(s).\n`);
    return;
  }

  let deleted = 0;
  while (true) {
    const batch = await prisma.assetPrice.findMany({
      where,
      select: { id: true },
      take: BATCH_SIZE,
    });
    if (batch.length === 0) break;

    const result = await prisma.assetPrice.deleteMany({
      where: { id: { in: batch.map(r => r.id) } },
    });
    deleted += result.count;
    console.log(`  Deleted batch of ${result.count} (${deleted}/${total})`);
  }

  console.log(`\n✅ Deleted ${deleted} AssetPrice record(s) for ${symbol}.\n`);
}

main()
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
