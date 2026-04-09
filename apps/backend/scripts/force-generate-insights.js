#!/usr/bin/env node
/**
 * force-generate-insights.js
 *
 * Forces a full insights generation run for a single tenant across all 5
 * tiers (DAILY, MONTHLY, QUARTERLY, ANNUAL, PORTFOLIO). Each call passes
 * `force: true` which bypasses the backend's completeness gate and the
 * `(tenantId, tier, periodKey, dataHash)` dedup check.
 *
 * Usage:
 *   node apps/backend/scripts/force-generate-insights.js <tenantId> [options]
 *
 * Options:
 *   --year=YYYY        Override the year used for MONTHLY/QUARTERLY/ANNUAL.
 *                      Default: last month's year (so MONTHLY/QUARTERLY run
 *                      against the most recent *complete* period).
 *   --month=M          Override the month for MONTHLY (1-12).
 *                      Default: the month before the current month.
 *   --quarter=Q        Override the quarter for QUARTERLY (1-4).
 *                      Default: the quarter containing the default month.
 *   --only=TIER[,...]  Only run the listed tiers. Comma-separated.
 *                      E.g. --only=DAILY,PORTFOLIO
 *   --skip=TIER[,...]  Skip the listed tiers.
 *   --dry-run          Print what would run without calling the service.
 *
 * Examples:
 *   # Force all 5 tiers for tenant abc123
 *   node apps/backend/scripts/force-generate-insights.js abc123
 *
 *   # Regenerate only the Q1 2026 quarterly review
 *   node apps/backend/scripts/force-generate-insights.js abc123 \
 *       --only=QUARTERLY --year=2026 --quarter=1
 *
 *   # Regenerate the 2025 annual report
 *   node apps/backend/scripts/force-generate-insights.js abc123 \
 *       --only=ANNUAL --year=2025
 *
 * The script loads the monorepo root `.env` (same as the backend service)
 * so it needs GEMINI_API_KEY, DATABASE_URL, and the usual encryption/JWT
 * secrets. Run it from anywhere — paths are resolved relative to this file.
 */

const path = require('node:path');

// Load the monorepo root .env before requiring anything that touches Prisma
// or Gemini. This mirrors apps/backend/src/index.js's env loading order.
require('dotenv').config({
  path: path.resolve(__dirname, '../../../.env'),
});

const prisma = require('../prisma/prisma.js');
const logger = require('../src/utils/logger');
const {
  generateTieredInsights,
  VALID_TIERS,
} = require('../src/services/insightService');

// ── CLI parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { tenantId: null, flags: {} };
  for (const token of argv.slice(2)) {
    if (token.startsWith('--')) {
      const [key, value] = token.slice(2).split('=');
      args.flags[key] = value === undefined ? true : value;
    } else if (!args.tenantId) {
      args.tenantId = token;
    }
  }
  return args;
}

function printUsageAndExit(code = 1) {
  const scriptPath = path.relative(process.cwd(), __filename);
  console.error(`Usage: node ${scriptPath} <tenantId> [--year=YYYY] [--month=M] [--quarter=Q] [--only=TIERS] [--skip=TIERS] [--dry-run]`);
  console.error('Tiers: DAILY, MONTHLY, QUARTERLY, ANNUAL, PORTFOLIO');
  process.exit(code);
}

function parseTierList(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const list = raw
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  const invalid = list.filter((t) => !VALID_TIERS.includes(t));
  if (invalid.length > 0) {
    console.error(`Invalid tier(s): ${invalid.join(', ')}`);
    console.error(`Valid tiers: ${VALID_TIERS.join(', ')}`);
    process.exit(1);
  }
  return list;
}

// ── Period defaulting ───────────────────────────────────────────────────────

/**
 * Default periods that target the most recent *completed* interval so the
 * underlying completeness checks (which `force: true` bypasses anyway) still
 * operate on sensible, data-rich windows.
 *
 *   MONTHLY:   the month before the current month
 *   QUARTERLY: the quarter containing that month
 *   ANNUAL:    the year before the current year
 */
function computeDefaultPeriods(now = new Date()) {
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1; // 1..12

  const priorMonthDate = new Date(Date.UTC(currentYear, currentMonth - 2, 1));
  const priorMonthYear = priorMonthDate.getUTCFullYear();
  const priorMonth = priorMonthDate.getUTCMonth() + 1;
  const priorQuarter = Math.ceil(priorMonth / 3);
  const priorYearForAnnual = currentYear - 1;

  return {
    monthly: { year: priorMonthYear, month: priorMonth },
    quarterly: { year: priorMonthYear, quarter: priorQuarter },
    annual: { year: priorYearForAnnual },
  };
}

function buildTierParams(tier, flags, defaults) {
  const year = flags.year ? parseInt(flags.year, 10) : undefined;
  const month = flags.month ? parseInt(flags.month, 10) : undefined;
  const quarter = flags.quarter ? parseInt(flags.quarter, 10) : undefined;

  switch (tier) {
    case 'DAILY':
    case 'PORTFOLIO':
      return { force: true };
    case 'MONTHLY':
      return {
        force: true,
        year: year ?? defaults.monthly.year,
        month: month ?? defaults.monthly.month,
      };
    case 'QUARTERLY':
      return {
        force: true,
        year: year ?? defaults.quarterly.year,
        quarter: quarter ?? defaults.quarterly.quarter,
      };
    case 'ANNUAL':
      return { force: true, year: year ?? defaults.annual.year };
    default:
      return { force: true };
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { tenantId, flags } = parseArgs(process.argv);
  if (!tenantId) {
    console.error('Missing required argument: tenantId');
    printUsageAndExit(1);
  }

  // Verify the tenant exists before spinning up any LLM calls.
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, portfolioCurrency: true },
  });
  if (!tenant) {
    console.error(`Tenant not found: ${tenantId}`);
    process.exit(2);
  }

  const only = parseTierList(flags.only);
  const skip = parseTierList(flags.skip) || [];
  const defaults = computeDefaultPeriods();
  const dryRun = Boolean(flags['dry-run']);

  const tiersToRun = VALID_TIERS.filter((tier) => {
    if (only && !only.includes(tier)) return false;
    if (skip.includes(tier)) return false;
    return true;
  });

  console.log('────────────────────────────────────────────────────────────');
  console.log(`Tenant:    ${tenant.name} (${tenant.id})`);
  console.log(`Currency:  ${tenant.portfolioCurrency || 'n/a'}`);
  console.log(`Tiers:     ${tiersToRun.join(', ')}`);
  console.log(`Dry run:   ${dryRun ? 'yes' : 'no'}`);
  console.log('────────────────────────────────────────────────────────────');

  const results = {};
  let failures = 0;

  for (const tier of tiersToRun) {
    const params = buildTierParams(tier, flags, defaults);
    console.log(`\n▶ ${tier}`, params);

    if (dryRun) {
      results[tier] = { skipped: true, reason: 'dry-run' };
      continue;
    }

    const startedAt = Date.now();
    try {
      const result = await generateTieredInsights(tenantId, tier, params);
      const elapsedMs = Date.now() - startedAt;

      if (result.skipped) {
        console.log(`  · skipped (${elapsedMs} ms): ${result.reason}`);
      } else {
        const count = Array.isArray(result.insights) ? result.insights.length : 0;
        console.log(
          `  · generated ${count} insight(s) in ${elapsedMs} ms` +
            (result.periodKey ? ` [period=${result.periodKey}]` : '') +
            (result.batchId ? ` [batch=${result.batchId.slice(0, 8)}]` : ''),
        );
      }
      results[tier] = result;
    } catch (err) {
      failures += 1;
      const elapsedMs = Date.now() - startedAt;
      console.error(`  ✗ failed in ${elapsedMs} ms: ${err.message}`);
      logger.error('Force-generate tier failed', {
        tenantId,
        tier,
        error: err.message,
        stack: err.stack,
      });
      results[tier] = { error: err.message };
    }
  }

  console.log('\n────────────────────────────────────────────────────────────');
  console.log('Summary:');
  for (const tier of tiersToRun) {
    const r = results[tier];
    let status;
    if (!r) status = 'missing';
    else if (r.error) status = `error: ${r.error}`;
    else if (r.skipped) status = `skipped (${r.reason})`;
    else status = `${(r.insights || []).length} insight(s)`;
    console.log(`  ${tier.padEnd(10)} → ${status}`);
  }
  console.log('────────────────────────────────────────────────────────────');

  return failures;
}

main()
  .then(async (failures) => {
    await prisma.$disconnect();
    process.exit(failures > 0 ? 1 : 0);
  })
  .catch(async (err) => {
    console.error('Fatal error:', err);
    logger.error('force-generate-insights fatal', { error: err.message, stack: err.stack });
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
