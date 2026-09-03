/**
 * Subscription / recurring-charge detection worker.
 *
 * Job types:
 *   - detect-tenant       { tenantId, mode: 'incremental' | 'full' }
 *                         Runs recurringDetectionService.detectForTenant() and
 *                         persists the result: one RecurringCharge row per
 *                         merchant. Detector fields are merged into existing
 *                         rows; the user-owned fields (state, userCadenceLocked,
 *                         a locked cadence) are never touched. Stale DETECTED
 *                         rows (no longer detected) are pruned. `mode: 'full'`
 *                         additionally stamps Tenant.subscriptionsFullScanAt.
 *
 *   - detect-all-tenants  {} — nightly cron (0 5 * * * UTC). Fans out one
 *                         incremental detect-tenant job per tenant that has
 *                         any transactions, 1s apart.
 *
 * Slots into the nightly chain AFTER analytics:
 *   securityMaster (3AM) → portfolio revaluation (4AM) → portfolio intel (Mon 5AM)
 *   → insights (6AM); subscription detection runs at 5AM independently (read-only
 *   over Transaction, writes only RecurringCharge — no cascade).
 */

const { Worker } = require('bullmq');
const logger = require('../utils/logger');
const { getRedisConnection } = require('../utils/redis');
const { reportWorkerFailure } = require('../utils/workerFailureReporter');
const {
  SUBSCRIPTION_DETECTION_QUEUE_NAME,
  getSubscriptionDetectionQueue,
} = require('../queues/subscriptionDetectionQueue');
const { detectForTenant } = require('../services/recurringDetectionService');

const prisma = require('../../prisma/prisma.js');

/** Detector-owned fields — always merged into an existing row. */
function detectorFields(row) {
  return {
    merchantLabel: row.merchantLabel,
    categoryId: row.categoryId,
    amount: row.amount,
    currency: row.currency,
    occurrenceCount: row.occurrenceCount,
    firstChargedAt: row.firstChargedAt,
    lastChargedAt: row.lastChargedAt,
    nextExpectedAt: row.nextExpectedAt,
    status: row.status,
    detectionReason: row.detectionReason,
    contributingTransactionIds: row.contributingTransactionIds,
    lastDetectedAt: row.lastDetectedAt,
  };
}

async function handleDetectTenant(data) {
  const startedAt = Date.now();
  const { tenantId, mode = 'incremental' } = data;
  if (!tenantId) throw new Error('detect-tenant job missing tenantId');

  const { rows, legacyRetireHashes = [], tierACount, tierBCount, tierBSkipped } =
    await detectForTenant(tenantId, { mode });

  // Existing rows for this tenant — so we know which cadences are user-locked
  // and which state to preserve on update.
  const existing = await prisma.recurringCharge.findMany({
    where: { tenantId },
    select: { descriptionHash: true, state: true, userCadenceLocked: true },
  });
  const existingByHash = new Map(existing.map((r) => [r.descriptionHash, r]));

  const desiredHashes = rows.map((r) => r.descriptionHash);

  const writes = rows.map((row) => {
    const prior = existingByHash.get(row.descriptionHash);
    const update = detectorFields(row);
    // Never overwrite a cadence the user has explicitly set.
    if (!prior?.userCadenceLocked) update.cadence = row.cadence;

    return prisma.recurringCharge.upsert({
      where: { tenantId_descriptionHash: { tenantId, descriptionHash: row.descriptionHash } },
      create: {
        tenantId,
        descriptionHash: row.descriptionHash,
        state: 'DETECTED',
        cadence: row.cadence,
        ...detectorFields(row),
      },
      update, // detector fields only — never state / userCadenceLocked
    });
  });

  // Prune DETECTED rows that are no longer detected. CONFIRMED / DISMISSED
  // tombstones are retained forever.
  const prune = prisma.recurringCharge.deleteMany({
    where: {
      tenantId,
      state: 'DETECTED',
      descriptionHash: { notIn: desiredHashes.length ? desiredHashes : ['__none__'] },
    },
  });

  // Retire the pre-clustering single row (any state) for merchants that this run
  // split into per-amount bands — e.g. the old combined "Apple" row and any
  // Confirm/Dismiss the user applied to it. The band rows carry `#`-suffixed
  // hashes so they can never collide with the retire list.
  const retire = prisma.recurringCharge.deleteMany({
    where: {
      tenantId,
      descriptionHash: { in: legacyRetireHashes.length ? legacyRetireHashes : ['__none__'] },
    },
  });

  const [pruneResult, retireResult] = await prisma.$transaction([prune, retire, ...writes]);

  if (mode === 'full') {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { subscriptionsFullScanAt: new Date() },
    });
  }

  const active = rows.filter((r) => r.status === 'ACTIVE').length;
  const lapsed = rows.filter((r) => r.status === 'LAPSED').length;
  logger.info('[subscriptionDetection] detect-tenant complete', {
    tenantId,
    mode,
    tierACount,
    tierBCount: tierBSkipped ? 'skipped' : tierBCount,
    detected: rows.length,
    active,
    lapsed,
    pruned: pruneResult?.count ?? 0,
    retired: retireResult?.count ?? 0,
    durationMs: Date.now() - startedAt,
  });

  return { detected: rows.length, active, lapsed, tierBSkipped };
}

async function handleDetectAllTenants() {
  const tenants = await prisma.tenant.findMany({
    where: { transactions: { some: {} } },
    select: { id: true },
  });
  const queue = getSubscriptionDetectionQueue();
  const dateKey = new Date().toISOString().slice(0, 10);

  let enqueued = 0;
  for (const t of tenants) {
    await queue.add(
      'detect-tenant',
      { tenantId: t.id, mode: 'incremental', source: 'nightly-cron' },
      { jobId: `subs-${t.id}-${dateKey}` },
    );
    enqueued += 1;
    await new Promise((r) => setTimeout(r, 1000)); // 1s spacing — gentle on Redis + DB
  }

  logger.info('[subscriptionDetection] detect-all-tenants fan-out complete', {
    tenants: tenants.length,
    enqueued,
  });
  return { tenants: tenants.length, enqueued };
}

const processJob = async (job) => {
  const { name, data } = job;
  switch (name) {
    case 'detect-tenant':
      return handleDetectTenant(data);
    case 'detect-all-tenants':
      return handleDetectAllTenants();
    default:
      throw new Error(`Unknown subscription detection job: ${name}`);
  }
};

const startSubscriptionDetectionWorker = () => {
  logger.info('Starting Subscription Detection Worker...');

  const worker = new Worker(SUBSCRIPTION_DETECTION_QUEUE_NAME, processJob, {
    connection: getRedisConnection(),
    concurrency: 1,
    lockDuration: 300000, // 5 minutes
  });

  // Nightly fan-out cron — 5 AM UTC (after portfolio intel, before insights).
  getSubscriptionDetectionQueue().add(
    'detect-all-tenants',
    {},
    {
      repeat: { pattern: '0 5 * * *' },
      jobId: 'nightly-subscription-detection',
    },
  );

  worker.on('completed', (job) => {
    logger.info('Subscription detection job completed:', { jobId: job.id, name: job.name, result: job.returnvalue });
  });

  worker.on('failed', (job, error) => {
    reportWorkerFailure({
      workerName: 'subscriptionDetectionWorker',
      job,
      error,
      extra: { mode: job?.data?.mode, tenantId: job?.data?.tenantId },
    });
  });

  return worker;
};

module.exports = { startSubscriptionDetectionWorker, processJob, handleDetectTenant, handleDetectAllTenants };
