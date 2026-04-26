#!/usr/bin/env node
/**
 * Backfill the category-model-overhaul changes for existing tenants.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES
 * ─────────────────────────────────────────────────────────────────────────────
 * The seed file (apps/api/lib/defaultCategories.js) was updated to:
 *   1. Add FREELANCE_INCOME, BONUS, COMMISSION under Labor Income
 *   2. Add TAX_REFUND under Taxes
 *   3. Move GOVERNMENT_WELFARE from Labor Income → Passive Income
 *
 * New tenants pick these up automatically at signup. This script applies the
 * same diff to every existing tenant. It is idempotent — safe to re-run.
 *
 * Because GOVERNMENT_WELFARE moves to a different group, the analytics cache
 * (AnalyticsCacheMonthly + TagAnalyticsCacheMonthly) is keyed on the OLD group
 * for affected tenants. After the DB writes, the script hits the backend's
 * `POST /api/admin/rebuild/trigger` with scope=full-analytics for every tenant
 * whose welfare row actually moved. Tenants where the regroup was a no-op
 * (already in Passive Income, manually moved elsewhere, or category absent)
 * are NOT rebuilt — pointless work. Pure-insert tenants are also skipped
 * since the new categories have no transactions yet.
 *
 * Default-category descriptions are NOT backfilled here. They live in i18n
 * (apps/web/src/i18n/locales/*.ts) and are picked up at render time by
 * translateCategoryDescription(). The Category.description column is reserved
 * for user-entered text on custom categories.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Usage:
 *   node scripts/backfill-category-model-v2.js                  # all tenants
 *   node scripts/backfill-category-model-v2.js --tenant=<id>    # one tenant
 *   node scripts/backfill-category-model-v2.js --dry-run        # report only
 *   node scripts/backfill-category-model-v2.js --skip-rebuild   # do DB writes
 *                                                               # but don't fire
 *                                                               # analytics rebuild
 *
 * Prerequisites (run from repo root):
 *   pnpm install
 *   pnpm --filter @bliss/shared build
 *
 * Then either run inside the backend container, or from the host with:
 *   NODE_PATH=$(pwd)/apps/backend/node_modules \
 *     node scripts/backfill-category-model-v2.js --dry-run
 *
 * The Prisma migration `20260426000000_add_category_description` must have
 * been applied first; otherwise Prisma client reads/writes will fail on the
 * `description` column.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const path = require('path');

require('dotenv').config({
  path: path.resolve(__dirname, '..', '.env'),
  override: true,
});

const prisma = require(path.resolve(__dirname, '..', 'apps', 'backend', 'prisma', 'prisma.js'));

// ─── The diff to apply ────────────────────────────────────────────────────────
// Hardcoded intentionally: this script encodes a specific one-time migration.
// Future seed changes get their own backfill script.

const NEW_CATEGORIES = [
  { code: 'FREELANCE_INCOME', name: 'Freelance Income', group: 'Labor Income',   type: 'Income', icon: '💼' },
  { code: 'BONUS',            name: 'Bonus',            group: 'Labor Income',   type: 'Income', icon: '🎁' },
  { code: 'COMMISSION',       name: 'Commission',       group: 'Labor Income',   type: 'Income', icon: '🤝' },
  { code: 'TAX_REFUND',       name: 'Tax Refund',       group: 'Taxes',          type: 'Income', icon: '↩️' },
];

const REGROUP = [
  { code: 'GOVERNMENT_WELFARE', from: 'Labor Income', to: 'Passive Income' },
];

// ─── CLI parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { tenant: null, dryRun: false, skipRebuild: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--skip-rebuild') opts.skipRebuild = true;
    else if (arg.startsWith('--tenant=')) opts.tenant = arg.slice('--tenant='.length);
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/backfill-category-model-v2.js [options]

Options:
  --tenant=<id>      Scope to a single tenant (default: all tenants)
  --dry-run          Report what would change, don't write
  --skip-rebuild     Do DB writes but don't trigger analytics rebuild
  -h, --help         Show this help
`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

// ─── Analytics rebuild trigger ───────────────────────────────────────────────
// POSTs to backend's POST /api/admin/rebuild/trigger with scope=full-analytics.
// The backend enforces a 1-hour single-flight lock per (tenant, scope), so a
// 409 response just means the tenant already has a rebuild in flight — log
// and continue. Anything else (network error, 5xx) is surfaced as a failure
// so the operator can re-run with --skip-rebuild and trigger from the
// Maintenance UI manually.
async function triggerFullAnalyticsRebuild(tenantId, backendUrl, apiKey) {
  const url = `${backendUrl.replace(/\/$/, '')}/api/admin/rebuild/trigger`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({
      tenantId,
      scope: 'full-analytics',
      requestedBy: 'backfill-category-model-v2',
    }),
  });
  if (res.status === 202) return { ok: true, status: 'enqueued' };
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    return { ok: true, status: `already-running (${body.ttlSeconds || '?'}s remaining)` };
  }
  const body = await res.text().catch(() => '');
  return { ok: false, status: `HTTP ${res.status}: ${body.slice(0, 200)}` };
}

// ─── Per-tenant work ──────────────────────────────────────────────────────────
async function processTenant(tenant, opts) {
  const result = {
    tenantId: tenant.id,
    tenantName: tenant.name,
    inserted: [],
    regrouped: [],
    skipped: [],
  };

  // Fetch current default categories so we know what already exists
  const existing = await prisma.category.findMany({
    where: { tenantId: tenant.id, defaultCategoryCode: { not: null } },
    select: { id: true, name: true, group: true, defaultCategoryCode: true },
  });
  const existingByCode = new Map(existing.map((c) => [c.defaultCategoryCode, c]));

  // 1. Inserts
  for (const cat of NEW_CATEGORIES) {
    if (existingByCode.has(cat.code)) {
      result.skipped.push(`${cat.code} (already exists)`);
      continue;
    }
    if (opts.dryRun) {
      result.inserted.push(cat.code);
      continue;
    }
    try {
      await prisma.category.create({
        data: {
          name: cat.name,
          group: cat.group,
          type: cat.type,
          icon: cat.icon,
          tenantId: tenant.id,
          defaultCategoryCode: cat.code,
          portfolioItemKeyStrategy: 'IGNORE',
        },
      });
      result.inserted.push(cat.code);
    } catch (err) {
      // P2002: unique constraint on (name, tenantId) — tenant has a custom
      // category with the same name. Skip gracefully and report.
      if (err.code === 'P2002') {
        result.skipped.push(`${cat.code} (name "${cat.name}" already taken by a custom category)`);
      } else {
        throw err;
      }
    }
  }

  // 2. Regroup moves (e.g. GOVERNMENT_WELFARE: Labor Income → Passive Income)
  for (const move of REGROUP) {
    const cat = existingByCode.get(move.code);
    if (!cat) {
      result.skipped.push(`${move.code} regroup (category missing — no-op)`);
      continue;
    }
    if (cat.group === move.to) {
      result.skipped.push(`${move.code} regroup (already in ${move.to})`);
      continue;
    }
    if (cat.group !== move.from) {
      // User has manually moved it somewhere else. Don't override their choice.
      result.skipped.push(`${move.code} regroup (currently in "${cat.group}", not "${move.from}" — leaving alone)`);
      continue;
    }
    if (opts.dryRun) {
      result.regrouped.push(`${move.code}: ${move.from} → ${move.to}`);
      continue;
    }
    await prisma.category.update({
      where: { id: cat.id },
      data: { group: move.to },
    });
    result.regrouped.push(`${move.code}: ${move.from} → ${move.to}`);
  }

  return result;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv);

  const backendUrl = process.env.BACKEND_URL;
  const internalApiKey = process.env.INTERNAL_API_KEY;
  const willRebuild = !opts.dryRun && !opts.skipRebuild;
  if (willRebuild && (!backendUrl || !internalApiKey)) {
    console.error('Missing BACKEND_URL or INTERNAL_API_KEY in env.');
    console.error('Either set them, or pass --skip-rebuild to do DB writes only.');
    process.exit(1);
  }

  console.log('Bliss — backfill category model v2');
  console.log(`  tenant scope    = ${opts.tenant || '(all)'}`);
  console.log(`  dry run         = ${opts.dryRun}`);
  console.log(`  trigger rebuild = ${willRebuild}${opts.skipRebuild ? ' (skipped via flag)' : ''}`);
  console.log('');

  const tenants = await prisma.tenant.findMany({
    where: opts.tenant ? { id: opts.tenant } : {},
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  if (tenants.length === 0) {
    console.log('No tenants found.');
    return;
  }

  console.log(`Processing ${tenants.length} tenant(s):\n`);

  const summary = { inserted: 0, regrouped: 0, skipped: 0, failed: 0 };
  const tenantsNeedingRebuild = [];

  for (const tenant of tenants) {
    try {
      const r = await processTenant(tenant, opts);
      const label = `${r.tenantName} (${r.tenantId})`;
      console.log(`▸ ${label}`);
      if (r.inserted.length) console.log(`    inserted : ${r.inserted.join(', ')}`);
      if (r.regrouped.length) console.log(`    regrouped: ${r.regrouped.join(', ')}`);
      if (r.skipped.length) console.log(`    skipped  : ${r.skipped.join(', ')}`);
      if (!r.inserted.length && !r.regrouped.length && !r.skipped.length) {
        console.log('    no-op (already up-to-date)');
      }
      summary.inserted += r.inserted.length;
      summary.regrouped += r.regrouped.length;
      summary.skipped += r.skipped.length;
      if (r.regrouped.length) tenantsNeedingRebuild.push(tenant);
    } catch (err) {
      summary.failed += 1;
      console.error(`  ✗ ${tenant.name} (${tenant.id}): ${err.message}`);
    }
  }

  // Trigger full-analytics rebuild for tenants whose welfare row actually
  // moved. Pure-insert tenants don't need rebuild — the new categories have
  // no transactions yet.
  const rebuildSummary = { triggered: 0, alreadyRunning: 0, failed: 0 };
  if (willRebuild && tenantsNeedingRebuild.length > 0) {
    console.log('');
    console.log(`Triggering full-analytics rebuild for ${tenantsNeedingRebuild.length} tenant(s):`);
    for (const tenant of tenantsNeedingRebuild) {
      const r = await triggerFullAnalyticsRebuild(tenant.id, backendUrl, internalApiKey);
      const label = `${tenant.name} (${tenant.id})`;
      if (r.ok) {
        console.log(`  ▸ ${label}: ${r.status}`);
        if (r.status === 'enqueued') rebuildSummary.triggered += 1;
        else rebuildSummary.alreadyRunning += 1;
      } else {
        console.error(`  ✗ ${label}: ${r.status}`);
        rebuildSummary.failed += 1;
      }
    }
  } else if (!opts.dryRun && !opts.skipRebuild && tenantsNeedingRebuild.length === 0) {
    console.log('');
    console.log('No tenants required analytics rebuild (no group regroups happened).');
  }

  console.log('');
  console.log('Summary');
  console.log(`  tenants processed = ${tenants.length}`);
  console.log(`  inserts           = ${summary.inserted}`);
  console.log(`  regroups          = ${summary.regrouped}`);
  console.log(`  skipped           = ${summary.skipped}`);
  console.log(`  failed tenants    = ${summary.failed}`);
  if (willRebuild) {
    console.log(`  rebuilds triggered      = ${rebuildSummary.triggered}`);
    console.log(`  rebuilds already running = ${rebuildSummary.alreadyRunning}`);
    console.log(`  rebuilds failed         = ${rebuildSummary.failed}`);
  }
  if (opts.dryRun) console.log('  (dry run — no writes were made, no rebuilds triggered)');
  if (opts.skipRebuild && !opts.dryRun) {
    console.log('  (--skip-rebuild — DB writes done; trigger rebuild manually from Maintenance UI)');
  }
}

main()
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
