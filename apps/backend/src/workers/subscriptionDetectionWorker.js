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

  const { rows, reconciliations = [], tierACount, tierBCount, tierBSkipped } =
    await detectForTenant(tenantId, { mode });

  // Existing rows for this tenant — so we know which cadences are user-locked
  // and which state to preserve on update, and which rows are merge targets.
  const existing = await prisma.recurringCharge.findMany({
    where: { tenantId },
    select: {
      descriptionHash: true,
      state: true,
      userCadenceLocked: true,
      userLabelLocked: true,
      mergedIntoHash: true,
    },
  });
  const existingByHash = new Map(existing.map((r) => [r.descriptionHash, r]));
  // descriptionHashes that some other row folds into — never prune these.
  const mergeTargetHashes = new Set(
    existing.filter((r) => r.mergedIntoHash).map((r) => r.mergedIntoHash),
  );

  const desiredHashes = rows.map((r) => r.descriptionHash);

  const writes = rows.map((row) => {
    const prior = existingByHash.get(row.descriptionHash);
    const update = detectorFields(row);
    // Never overwrite a cadence the user has explicitly set.
    if (!prior?.userCadenceLocked) update.cadence = row.cadence;
    // Never overwrite a merchant label the user has renamed.
    if (prior?.userLabelLocked) delete update.merchantLabel;

    return prisma.recurringCharge.upsert({
      where: { tenantId_descriptionHash: { tenantId, descriptionHash: row.descriptionHash } },
      create: {
        tenantId,
        descriptionHash: row.descriptionHash,
        // Durable identity, assigned once at creation and never re-derived.
        chargeKey: row.chargeKey || row.descriptionHash,
        state: 'DETECTED',
        cadence: row.cadence,
        ...detectorFields(row),
      },
      update, // detector fields only — never state / userCadenceLocked / chargeKey
    });
  });

  // Promote a brand-new split-band row that inherited a CONFIRMED decision from
  // the bare row it replaced (see recurringDetectionService reconciliation).
  const promoteWrites = rows
    .filter((r) => r._promoteState)
    .map((r) => prisma.recurringCharge.updateMany({
      where: { tenantId, descriptionHash: r.descriptionHash },
      data: { state: r._promoteState },
    }));

  // Reconciliation: two or more decided rows resolved to one identity this run
  // (bands collapsed, or a bare row split into per-amount bands). The winner
  // keeps the strongest decision + any user lock; the loser row is deleted.
  // This is explicitly distinct from prune/retire — no user decision is lost.
  const reconWinnerWrites = [];
  const reconLoserDeletes = [];
  for (const rec of reconciliations) {
    const data = {};
    if (rec.promoteState) data.state = rec.promoteState;
    if (rec.carryCadence) { data.cadence = rec.carryCadence; data.userCadenceLocked = true; }
    if (rec.carryLabel) { data.merchantLabel = rec.carryLabel; data.userLabelLocked = true; }
    if (Object.keys(data).length) {
      reconWinnerWrites.push(prisma.recurringCharge.updateMany({
        where: { tenantId, descriptionHash: rec.winnerDescriptionHash },
        data,
      }));
    }
    reconLoserDeletes.push(prisma.recurringCharge.deleteMany({
      where: { tenantId, id: rec.loserId },
    }));
  }

  // Prune DETECTED rows that are no longer detected. CONFIRMED / DISMISSED
  // rows, merge tombstones (`mergedIntoHash` set) and merge *targets* are all
  // retained — the guard against ever deleting a user decision or a fold target.
  const prune = prisma.recurringCharge.deleteMany({
    where: {
      tenantId,
      state: 'DETECTED',
      mergedIntoHash: null,
      descriptionHash: {
        notIn: [...new Set([
          ...(desiredHashes.length ? desiredHashes : ['__none__']),
          ...mergeTargetHashes,
        ])],
      },
    },
  });

  const [pruneResult] = await prisma.$transaction([
    prune,
    ...writes,
    ...promoteWrites,
    ...reconWinnerWrites,
    ...reconLoserDeletes,
  ]);

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
    reconciled: reconciliations.length,
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
