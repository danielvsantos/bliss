/**
 * Integration test: per-tenant deduplication of `value-all-assets` against a
 * real Redis + BullMQ.
 *
 * Guards the fix for concurrent full valuations: back-to-back import cascades
 * used to enqueue several `value-all-assets` jobs for the same tenant, which
 * then ran side by side (portfolio concurrency 5), each wiping and rebuilding
 * the same history and re-fetching the same prices.
 *
 * The critical property verified here is that the dedup key is released when
 * the job completes, even though completed jobs are retained for 24h — a plain
 * custom `jobId` would silently block every revaluation for a day.
 *
 * A throwaway queue name is used so this can never consume real `portfolio`
 * jobs if REDIS_URL points at a shared instance.
 */

const IORedis = require('ioredis');
const { Queue, Worker } = require('bullmq');
const { fullValuationDedupOpts } = require('../../queues/portfolioQueue');

const QUEUE_NAME = `test-valuation-dedup-${process.pid}-${Date.now()}`;

describe('value-all-assets per-tenant deduplication (real BullMQ)', () => {
  let connection;
  let workerConnection;
  let queue;
  let worker;

  beforeAll(() => {
    connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue(QUEUE_NAME, {
      connection,
      // Mirrors the retention in queues/portfolioQueue.js — the reason a
      // fixed jobId can't be used for this dedup.
      defaultJobOptions: { removeOnComplete: { age: 24 * 3600, count: 1000 } },
    });
  });

  afterAll(async () => {
    if (worker) await worker.close();
    if (workerConnection) await workerConnection.quit();
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
  });

  it('dedupes while pending/active, isolates tenants, and releases the key on completion', async () => {
    const add = (tenantId) =>
      queue.add('value-all-assets', { tenantId }, fullValuationDedupOpts(tenantId));

    // 1. Repeated adds while the first job is still waiting collapse onto it.
    const first = await add('tenant-a');
    const second = await add('tenant-a');
    expect(second.id).toBe(first.id);

    // 2. A different tenant is never blocked.
    const other = await add('tenant-b');
    expect(other.id).not.toBe(first.id);
    expect(await queue.getWaitingCount()).toBe(2);

    // 3. While tenant-a's job is ACTIVE, further adds are still dropped —
    //    this is the concurrent-valuation case from the bug report.
    let releaseA;
    const aBlocked = new Promise((resolve) => { releaseA = resolve; });
    let markActive;
    const aActive = new Promise((resolve) => { markActive = resolve; });

    workerConnection = connection.duplicate();
    worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        if (job.data.tenantId === 'tenant-a') {
          markActive();
          await aBlocked;
        }
        return 'ok';
      },
      { connection: workerConnection, concurrency: 2 },
    );

    await aActive;
    const whileActive = await add('tenant-a');
    expect(whileActive.id).toBe(first.id);

    // 4. After completion the key is released, so the next cascade gets a
    //    fresh job even though the completed one is still retained.
    const completed = new Promise((resolve) => {
      worker.on('completed', (job) => { if (job.id === first.id) resolve(); });
    });
    releaseA();
    await completed;

    const retained = await queue.getJob(first.id);
    expect(retained).toBeDefined();
    expect(await retained.getState()).toBe('completed');

    const next = await add('tenant-a');
    expect(next.id).not.toBe(first.id);
  });
});
