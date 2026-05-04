/**
 * diagnose-portfolio.js
 *
 * Exports all PortfolioItem state, linked transactions, and ManualAssetValue
 * records for a given set of symbols so we can debug account-scope issues.
 *
 * Usage (from repo root):
 *   TENANT_ID=cmn7gpm2t00002fgzi5t28wpk \
 *   SYMBOLS="LETS,Pension Plan:PGBL" \
 *   node scripts/diagnose-portfolio.js
 *
 * Output: scripts/diag-<timestamp>.json  +  a human-readable summary to stdout.
 */

'use strict';

const path = require('path');
// Load env from repo root .env
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { PrismaClient } = require('@prisma/client');
const fs = require('fs');

const prisma = new PrismaClient();

const TENANT_ID = process.env.TENANT_ID;
const SYMBOLS   = (process.env.SYMBOLS || 'LETS,Pension Plan:PGBL')
  .split(',')
  .map(s => s.trim());

if (!TENANT_ID) {
  console.error('ERROR: set TENANT_ID env var');
  process.exit(1);
}

async function main() {
  const report = {};

  for (const sym of SYMBOLS) {
    console.log(`\n=== ${sym} ===`);

    // ── Portfolio items ──────────────────────────────────────────────────────
    const items = await prisma.portfolioItem.findMany({
      where: { tenantId: TENANT_ID, symbol: sym },
      include: {
        account:     { select: { id: true, name: true, bankId: true } },
        category:    { select: { name: true, type: true, processingHint: true } },
        manualValues: { orderBy: { date: 'asc' } },
        debtTerms:   true,
      },
    });

    const itemsOut = items.map(item => ({
      id:              item.id,
      symbol:          item.symbol,
      accountId:       item.accountId,
      accountName:     item.account?.name ?? null,
      source:          item.source,
      quantity:        item.quantity?.toString() ?? null,
      costBasis:       item.costBasis?.toString() ?? null,
      currentValue:    item.currentValue?.toString() ?? null,
      realizedPnL:     item.realizedPnL?.toString() ?? null,
      costBasisInUSD:  item.costBasisInUSD?.toString() ?? null,
      currentValueInUSD: item.currentValueInUSD?.toString() ?? null,
      hasLotMismatch:  item.hasLotMismatch,
      category:        item.category,
      manualValues: item.manualValues.map(mv => ({
        id:       mv.id,
        date:     mv.date?.toISOString().slice(0, 10),
        value:    mv.value?.toString(),
        currency: mv.currency,
        notes:    mv.notes ?? null,
      })),
      debtTerms: item.debtTerms ?? null,
    }));

    // ── Transactions ─────────────────────────────────────────────────────────
    const itemIds = items.map(i => i.id);
    const txs = itemIds.length
      ? await prisma.transaction.findMany({
          where: { portfolioItemId: { in: itemIds } },
          select: {
            id:               true,
            transaction_date: true,
            description:      true,
            debit:            true,
            credit:           true,
            currency:         true,
            assetQuantity:    true,
            assetPrice:       true,
            ticker:           true,
            accountId:        true,
            portfolioItemId:  true,
            category:  { select: { name: true, processingHint: true } },
            account:   { select: { name: true } },
          },
          orderBy: { transaction_date: 'asc' },
        })
      : [];

    const txsOut = txs.map(tx => ({
      id:              tx.id,
      date:            tx.transaction_date?.toISOString().slice(0, 10),
      description:     tx.description,
      debit:           tx.debit?.toString() ?? null,
      credit:          tx.credit?.toString() ?? null,
      currency:        tx.currency,
      assetQuantity:   tx.assetQuantity?.toString() ?? null,
      assetPrice:      tx.assetPrice?.toString() ?? null,
      ticker:          tx.ticker ?? null,
      accountId:       tx.accountId,
      accountName:     tx.account?.name ?? null,
      portfolioItemId: tx.portfolioItemId,
      categoryName:    tx.category?.name ?? null,
      processingHint:  tx.category?.processingHint ?? null,
    }));

    // ── Orphaned manual values (assetId not in current items) ────────────────
    // These exist if ManualAssetValues were left behind after item ID changed.
    const orphanedMVs = await prisma.manualAssetValue.findMany({
      where: {
        tenantId: TENANT_ID,
        assetId:  { notIn: itemIds.length ? itemIds : [-1] },
        // We can't filter by symbol on ManualAssetValue directly,
        // but we fetch all for the tenant with a loose date range and
        // cross-reference in-memory.
      },
    });
    // Filter: only ones whose assetId references a deleted PortfolioItem
    // (we can detect this if the item is gone — prisma won't follow the FK).
    // Since the item is deleted, these won't normally appear; include for completeness.

    report[sym] = {
      portfolioItems: itemsOut,
      transactions:   txsOut,
      summary: {
        itemCount:        itemsOut.length,
        txCount:          txsOut.length,
        totalManualValues: itemsOut.reduce((s, i) => s + i.manualValues.length, 0),
        itemsWithManualValues: itemsOut.filter(i => i.manualValues.length > 0).map(i => ({
          id: i.id, accountName: i.accountName, mvCount: i.manualValues.length,
        })),
        itemsWithoutManualValues: itemsOut.filter(i => i.manualValues.length === 0).map(i => ({
          id: i.id, accountName: i.accountName,
        })),
        hasLotMismatchItems: itemsOut.filter(i => i.hasLotMismatch).map(i => ({
          id: i.id, accountName: i.accountName,
        })),
        uniqueTickersInTxs:    [...new Set(txsOut.map(t => t.ticker).filter(Boolean))],
        uniqueAccountsInTxs:   [...new Set(txsOut.map(t => t.accountName).filter(Boolean))],
        processingHints:       [...new Set(txsOut.map(t => t.processingHint).filter(Boolean))],
      },
    };

    // ── Console summary ──────────────────────────────────────────────────────
    const s = report[sym].summary;
    console.log(`  Portfolio items : ${s.itemCount}`);
    itemsOut.forEach(i => {
      console.log(`    [id=${i.id}] accountId=${i.accountId ?? 'null'} (${i.accountName ?? 'no account'})`
        + ` source=${i.source} qty=${i.quantity} hasLotMismatch=${i.hasLotMismatch}`
        + ` manualValues=${i.manualValues.length} processingHint=${i.category?.processingHint}`);
    });
    console.log(`  Transactions    : ${s.txCount}`);
    console.log(`  Tickers in txs  : ${s.uniqueTickersInTxs.join(', ') || '(none)'}`);
    console.log(`  Accounts in txs : ${s.uniqueAccountsInTxs.join(', ') || '(none)'}`);
    console.log(`  Processing hints: ${s.processingHints.join(', ') || '(none)'}`);
    if (s.itemsWithoutManualValues.length) {
      console.log(`  ⚠  Items MISSING manual values: ${s.itemsWithoutManualValues.map(i => `id=${i.id} (${i.accountName})`).join(', ')}`);
    }
    if (s.hasLotMismatchItems.length) {
      console.log(`  ⚠  Items with lot mismatch: ${s.hasLotMismatchItems.map(i => `id=${i.id} (${i.accountName})`).join(', ')}`);
    }
  }

  const outFile = path.resolve(__dirname, `diag-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\n✅ Full export written to ${outFile}`);
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
