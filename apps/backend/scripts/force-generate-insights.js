#!/usr/bin/env node
/**
 * force-generate-insights.js
 *
 * Thin operator CLI that triggers a full insights generation run for a
 * single tenant across all 4 tiers (MONTHLY, QUARTERLY, ANNUAL, PORTFOLIO)
 * via the backend's internal HTTP endpoint.
 *
 * This script does **not** import insightService, Prisma, or Gemini. It
 * simply POSTs to `BACKEND_URL/api/insights/generate` with an `X-API-KEY`
 * header — the same pattern the API layer uses when the frontend calls
 * POST `/api/insights`. The backend worker picks up each job from BullMQ
 * and runs it through the normal production code path (retries, Sentry,
 * worker concurrency, and all).
 *
 * Each call passes `force: true` which bypasses the backend's completeness
 * gate and the `(tenantId, tier, periodKey, dataHash)` dedup check.
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
 *                      E.g. --only=MONTHLY,PORTFOLIO
 *   --skip=TIER[,...]  Skip the listed tiers.
 *   --dry-run          Print what would be POSTed without firing the call.
 *
 * Examples:
 *   # Force all 4 tiers for tenant abc123
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
 * Environment:
 *   BACKEND_URL         Default: http://localhost:3001
 *   INTERNAL_API_KEY    Required — same value the backend middleware checks
 *
 * The script loads the monorepo root `.env` (same as the backend service)
 * so it picks up both vars automatically when run against a local stack.
 * Since it only talks HTTP, the backend must be running (or the jobs will
 * queue on your local Redis if the backend is stopped).
 */

const path = require('node:path');

// Load the monorepo root .env so BACKEND_URL + INTERNAL_API_KEY are available.
require('dotenv').config({
  path: path.resolve(__dirname, '../../../.env'),
});

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

const VALID_TIERS = ['MONTHLY', 'QUARTERLY', 'ANNUAL', 'PORTFOLIO'];

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
  console.error('Tiers: MONTHLY, QUARTERLY, ANNUAL, PORTFOLIO');
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

function buildTierPayload(tenantId, tier, flags, defaults) {
  const year = flags.year ? parseInt(flags.year, 10) : undefined;
  const month = flags.month ? parseInt(flags.month, 10) : undefined;
  const quarter = flags.quarter ? parseInt(flags.quarter, 10) : undefined;

  const base = { tenantId, tier, force: true };

  switch (tier) {
    case 'PORTFOLIO':
      return base;
    case 'MONTHLY':
      return {
        ...base,
        year: year ?? defaults.monthly.year,
        month: month ?? defaults.monthly.month,
      };
    case 'QUARTERLY':
      return {
        ...base,
        year: year ?? defaults.quarterly.year,
        quarter: quarter ?? defaults.quarterly.quarter,
      };
    case 'ANNUAL':
      return { ...base, year: year ?? defaults.annual.year };
    default:
      return base;
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────

async function postGenerateJob(payload) {
  const url = `${BACKEND_URL}/api/insights/generate`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': INTERNAL_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON response body — leave as null and surface the status
  }

  return { status: response.status, body };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { tenantId, flags } = parseArgs(process.argv);
  if (!tenantId) {
    console.error('Missing required argument: tenantId');
    printUsageAndExit(1);
  }

  if (!INTERNAL_API_KEY) {
    console.error('INTERNAL_API_KEY is not set. Add it to the root .env or export it before running.');
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
  console.log(`Tenant:    ${tenantId}`);
  console.log(`Backend:   ${BACKEND_URL}`);
  console.log(`Tiers:     ${tiersToRun.join(', ')}`);
  console.log(`Dry run:   ${dryRun ? 'yes' : 'no'}`);
  console.log('────────────────────────────────────────────────────────────');

  const results = {};
  let failures = 0;

  for (const tier of tiersToRun) {
    const payload = buildTierPayload(tenantId, tier, flags, defaults);
    console.log(`\n▶ ${tier}`, payload);

    if (dryRun) {
      results[tier] = { skipped: true, reason: 'dry-run' };
      continue;
    }

    const startedAt = Date.now();
    try {
      const { status, body } = await postGenerateJob(payload);
      const elapsedMs = Date.now() - startedAt;

      if (status === 202) {
        console.log(`  · enqueued in ${elapsedMs} ms — backend worker will run it asynchronously`);
        if (body?.message) console.log(`  · backend: ${body.message}`);
        results[tier] = { enqueued: true, status, body };
      } else {
        failures += 1;
        const reason = body?.error || `HTTP ${status}`;
        console.error(`  ✗ backend rejected in ${elapsedMs} ms: ${reason}`);
        results[tier] = { error: reason };
      }
    } catch (err) {
      failures += 1;
      const elapsedMs = Date.now() - startedAt;
      console.error(`  ✗ network error in ${elapsedMs} ms: ${err.message}`);
      results[tier] = { error: err.message };
    }
  }

  console.log('\n────────────────────────────────────────────────────────────');
  console.log('Summary (jobs are now queued — tail the backend logs to see generation):');
  for (const tier of tiersToRun) {
    const r = results[tier];
    let status;
    if (!r) status = 'missing';
    else if (r.error) status = `error: ${r.error}`;
    else if (r.skipped) status = `skipped (${r.reason})`;
    else status = 'enqueued';
    console.log(`  ${tier.padEnd(10)} → ${status}`);
  }
  console.log('────────────────────────────────────────────────────────────');

  return failures;
}

main()
  .then((failures) => {
    process.exit(failures > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
