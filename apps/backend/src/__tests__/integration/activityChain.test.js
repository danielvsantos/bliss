/**
 * Integration test: processing status (#100) against a real Redis + BullMQ.
 *
 *  - The Lua write script's guards (queued is HSETNX, finished entries are
 *    never overwritten, `:last` stamping, drop, pruning).
 *  - AC1: a transaction-edit chain (event → portfolio → event → analytics)
 *    always has at least one entry in flight until its last job completes —
 *    no gap between stages.
 *  - AC2: ten debounced edits leave one coalesced PORTFOLIO_UPDATE row and no
 *    orphaned `queued` entries for the removed jobs.
 *  - A deduplicated add never resets an active entry; a failure only shows on
 *    the final attempt (AC8).
 *
 * The queues use the production names (the activity map keys on them) under a
 * throwaway BullMQ `prefix`, so this never touches real `bull:*` keys even if
 * REDIS_URL points at a shared instance. Tenants are unique per run.
 */

const IORedis = require('ioredis');
const { Queue, Worker } = require('bullmq');
const { summarize, activityKey, lastKey } = require('@bliss/shared/activity');
const tracker = require('../../utils/activityTracker');
const { initializeRedis, disconnectRedis } = require('../../utils/redis');
const { scheduleDebouncedJob } = require('../../services/debounceService');
const { fullValuationDedupOpts } = require('../../queues/portfolioQueue');

const PREFIX = `test-activity-${process.pid}-${Date.now()}`;
const RUN = `${process.pid}-${Date.now()}`;

let redis; // reader + tracker client
const queues = [];
const workers = [];
const connections = []; // BullMQ never closes connections it was handed

const dup = (opts) => {
  const c = redis.duplicate(opts);
  connections.push(c);
  return c;
};

// Each test gets its own prefix so one test's workers never take another's jobs.
let prefix = PREFIX;

const makeQueue = (name) => {
  const q = new Queue(name, { connection: dup(), prefix });
  tracker.trackQueue(q);
  queues.push(q);
  return q;
};

const makeWorker = (name, processor, opts = {}) => {
  const w = new Worker(name, processor, { connection: dup({ maxRetriesPerRequest: null }), prefix, ...opts });
  tracker.trackWorker(w, name);
  workers.push(w);
  return w;
};

async function snapshot(tenantId) {
  const [[, raw], [, last]] = await redis.pipeline().hgetall(activityKey(tenantId)).hgetall(lastKey(tenantId)).exec();
  return summarize(raw, last, true);
}

/** Resolves once `predicate(snapshot)` holds (polling), or rejects after `timeoutMs`. */
async function waitFor(tenantId, predicate, timeoutMs = 10_000) {
  const start = Date.now();
  for (;;) {
    const snap = await snapshot(tenantId);
    if (predicate(snap)) return snap;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${JSON.stringify(snap)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const write = (tenantId, field, entry, mode, completedAt = '') => redis.activityWrite(
  activityKey(tenantId), lastKey(tenantId), field, entry ? JSON.stringify(entry) : '', mode, entry?.t || '', completedAt,
  '86400', String(Date.now()), String(24 * 3600 * 1000), '200', '500', String(10 * 60 * 1000),
);

beforeAll(async () => {
  await initializeRedis();
  redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  redis.defineCommand('activityWrite', { numberOfKeys: 2, lua: tracker.WRITE_SCRIPT });
  tracker.__setClientForTests(redis);
});

afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  for (const q of queues) {
    await q.obliterate({ force: true });
    await q.close();
  }
  await Promise.all(connections.map((c) => c.quit()));
  const keys = await redis.keys(`activity:v1:act-${RUN}-*`);
  if (keys.length) await redis.del(...keys);
  tracker.__setClientForTests(null);
  await redis.quit();
  await disconnectRedis();
});

describe('write script (real Redis)', () => {
  const tenant = `act-${RUN}-lua`;
  const now = Date.now();
  const entry = (st, extra = {}) => ({ t: 'PORTFOLIO_UPDATE', s: 'valuing_assets', st, sa: now, ua: now, af: ['PORTFOLIO_UPDATE'], ...extra });

  it('queued is set-if-absent and never resets a running entry', async () => {
    expect(await write(tenant, 'portfolio:1', entry('queued'), 'queued')).toBe(1);
    expect(await write(tenant, 'portfolio:1', entry('running'), 'update')).toBe(1);
    expect(await write(tenant, 'portfolio:1', entry('queued'), 'queued')).toBe(0);
    expect(JSON.parse(await redis.hget(activityKey(tenant), 'portfolio:1')).st).toBe('running');
    expect(await redis.ttl(activityKey(tenant))).toBeGreaterThan(86_000);
  });

  it('a finished entry is never overwritten, and completion stamps :last', async () => {
    const at = new Date().toISOString();
    expect(await write(tenant, 'portfolio:1', entry('completed', { fa: Date.now() }), 'terminal', at)).toBe(1);
    expect(await write(tenant, 'portfolio:1', entry('running', { p: 50 }), 'update')).toBe(0);
    expect(await write(tenant, 'portfolio:1', entry('failed'), 'terminal')).toBe(0);
    expect(JSON.parse(await redis.hget(activityKey(tenant), 'portfolio:1')).st).toBe('completed');
    expect(await redis.hget(lastKey(tenant), 'PORTFOLIO_UPDATE')).toBe(at);
    expect(await redis.ttl(lastKey(tenant))).toBe(-1); // no TTL by design
  });

  it('a failure does not stamp :last; drop leaves a tombstone the summary ignores', async () => {
    await write(tenant, 'analytics:2', { ...entry('failed', { fa: Date.now(), ec: 'P2034' }), t: 'ANALYTICS_UPDATE' }, 'terminal', '');
    expect(await redis.hget(lastKey(tenant), 'ANALYTICS_UPDATE')).toBeNull();
    await write(tenant, 'portfolio:3', entry('queued'), 'queued');
    expect(await write(tenant, 'portfolio:3', null, 'drop')).toBe(1);
    expect(JSON.parse(await redis.hget(activityKey(tenant), 'portfolio:3'))).toMatchObject({ st: 'gone' });
    const snap = await snapshot(tenant);
    expect(snap.inFlight.map((e) => e.id)).not.toContain('portfolio:3');
    expect(snap.recent.map((e) => e.id)).not.toContain('portfolio:3');
  });

  it('a queued write that lands after the drop cannot resurrect the entry (split web + worker)', async () => {
    // Worker service: the event hop runs and is dropped in ~5 ms...
    await write(tenant, 'events:9', entry('running', { t: 'ANALYTICS_UPDATE', s: 'scheduling' }), 'update');
    await write(tenant, 'events:9', null, 'drop');
    // ...before the web service's queued write for the same job reaches Redis.
    expect(await write(tenant, 'events:9', entry('queued', { t: 'ANALYTICS_UPDATE', s: 'scheduling' }), 'queued')).toBe(0);
    expect(await write(tenant, 'events:9', entry('running', { t: 'ANALYTICS_UPDATE' }), 'update')).toBe(0);
    expect((await snapshot(tenant)).inFlight.map((e) => e.id)).not.toContain('events:9');
  });

  it('prunes tombstones once they are older than the tombstone age', async () => {
    const t = `act-${RUN}-tomb`;
    const pipe = redis.pipeline();
    for (let i = 0; i < 250; i++) pipe.hset(activityKey(t), `events:old${i}`, JSON.stringify({ st: 'gone', ua: Date.now() - 11 * 60 * 1000 }));
    pipe.hset(activityKey(t), 'events:fresh', JSON.stringify({ st: 'gone', ua: Date.now() }));
    await pipe.exec();

    await write(t, 'portfolio:new', entry('completed', { fa: Date.now() }), 'terminal', new Date().toISOString());

    const fields = Object.keys(await redis.hgetall(activityKey(t)));
    expect(fields.sort()).toEqual(['events:fresh', 'portfolio:new']);
  });

  it('prunes old entries, then the oldest finished ones, once the hash outgrows the threshold', async () => {
    const t = `act-${RUN}-prune`;
    const old = Date.now() - 25 * 3600 * 1000;
    const pipe = redis.pipeline();
    for (let i = 0; i < 150; i++) pipe.hset(activityKey(t), `old:${i}`, JSON.stringify(entry('queued', { sa: old, ua: old })));
    for (let i = 0; i < 600; i++) pipe.hset(activityKey(t), `done:${i}`, JSON.stringify(entry('completed', { fa: Date.now() - 1000 + i })));
    pipe.hset(activityKey(t), 'live:1', JSON.stringify(entry('running')));
    await pipe.exec();

    await write(t, 'portfolio:new', entry('completed', { fa: Date.now() + 10_000 }), 'terminal', new Date().toISOString());

    const all = await redis.hgetall(activityKey(t));
    const fields = Object.keys(all);
    expect(fields.length).toBe(500);
    expect(fields.some((f) => f.startsWith('old:'))).toBe(false);
    expect(fields).toContain('live:1'); // in-flight entries are never capped away
    expect(fields).toContain('portfolio:new');
    expect(fields).not.toContain('done:0'); // oldest finished go first
  });
});

describe('BullMQ chain (real Redis)', () => {
  let n = 0;
  beforeEach(() => { prefix = `${PREFIX}-${++n}`; });

  it('AC1: an edit chain has no gap between stages and clears when the last stage completes', async () => {
    const tenantId = `act-${RUN}-chain`;
    const events = makeQueue('events');
    const portfolio = makeQueue('portfolio');
    const analytics = makeQueue('analytics');

    let finished = false;
    makeWorker('events', async (job) => {
      // Like eventSchedulerWorker: every downstream job carries the chain's origin (run id).
      const carry = tracker.carryOrigin('events', job);
      if (job.name === 'MANUAL_TRANSACTION_MODIFIED') {
        await portfolio.add('process-cash-holdings', { tenantId, scope: { year: 2026 }, ...carry }, { delay: 50 });
      } else if (job.name === 'CASH_HOLDINGS_PROCESSED') {
        await analytics.add('scoped-update-analytics', { tenantId, scopes: [{ year: 2026 }], ...carry }, { delay: 50 });
      }
    });
    makeWorker('portfolio', async (job) => {
      await new Promise((r) => setTimeout(r, 40));
      await events.add('CASH_HOLDINGS_PROCESSED', { tenantId, ...tracker.carryOrigin('portfolio', job) });
    });
    const analyticsWorker = makeWorker('analytics', async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    analyticsWorker.on('completed', () => { finished = true; });

    await events.add('MANUAL_TRANSACTION_MODIFIED', { tenantId });
    await waitFor(tenantId, (s) => s.inFlight.length > 0);

    // Poll continuously: every snapshot before the final completion must
    // show something in flight affecting the analytics page (Expenses).
    const samples = [];
    while (!finished) {
      const snap = await snapshot(tenantId);
      samples.push(snap);
      if (!finished) {
        expect(snap.inFlight.length).toBeGreaterThan(0);
        expect(snap.inFlight.some((e) => e.affects.includes('ANALYTICS_UPDATE'))).toBe(true);
      }
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(samples.length).toBeGreaterThan(10);
    const types = new Set(samples.flatMap((s) => s.inFlight.map((e) => e.type)));
    expect(types).toEqual(new Set(['PORTFOLIO_UPDATE', 'ANALYTICS_UPDATE']));

    const done = await waitFor(tenantId, (s) => s.inFlight.length === 0);
    expect(done.summary).toEqual({});
    expect(done.lastCompletedAt.PORTFOLIO_UPDATE).toBeDefined();
    expect(done.lastCompletedAt.ANALYTICS_UPDATE).toBeDefined();
    // Event hops leave no history; the two real jobs do.
    expect(done.recent.map((r) => r.type).sort()).toEqual(['ANALYTICS_UPDATE', 'PORTFOLIO_UPDATE']);
    expect(done.recent.every((r) => r.state === 'completed' && r.durationMs >= 0)).toBe(true);
    // The whole chain is ONE run in the history, with both jobs as its steps.
    expect(done.runs).toHaveLength(1);
    expect(done.runs[0]).toMatchObject({ state: 'completed', types: ['PORTFOLIO_UPDATE', 'ANALYTICS_UPDATE'] });
    expect(done.runs[0].steps.map((s) => s.stage)).toEqual(['updating_cash', 'updating_analytics']);
  });

  it('AC2: ten debounced edits coalesce into one row with no orphaned entries', async () => {
    const tenantId = `act-${RUN}-debounce`;
    const portfolio = makeQueue('portfolio');

    for (let i = 0; i < 10; i++) {
      await scheduleDebouncedJob(portfolio, 'process-cash-holdings',
        { tenantId, needsCashRebuild: [true], scope: { year: 2026 } }, 'needsCashRebuild', 30);
    }
    // Drops are fire-and-forget: wait until only the surviving job remains.
    const snap = await waitFor(tenantId, (s) => s.inFlight.length === 1);
    expect(Object.keys(snap.summary)).toEqual(['PORTFOLIO_UPDATE']);
    expect(snap.summary.PORTFOLIO_UPDATE).toMatchObject({ state: 'queued', count: 1, stage: 'updating_cash' });
    expect(await portfolio.getDelayedCount()).toBe(1);
    await redis.del(`debounce:process-cash-holdings:tenant:${tenantId}`);
  });

  it('a debounced edit after the previous job already ran keeps that job\'s history row', async () => {
    const tenantId = `act-${RUN}-ran`;
    const portfolio = makeQueue('portfolio');
    makeWorker('portfolio', async () => {});
    const schedule = () => scheduleDebouncedJob(portfolio, 'process-cash-holdings',
      { tenantId, needsCashRebuild: [true], scope: { year: 2026 } }, 'needsCashRebuild', 0);

    await schedule();
    await waitFor(tenantId, (s) => s.recent.length === 1 && s.inFlight.length === 0);
    // Within the debounce record's lifetime (delay + 5 s), the first job is done.
    await schedule();
    const snap = await waitFor(tenantId, (s) => s.recent.length === 2 && s.inFlight.length === 0);
    expect(snap.recent.every((r) => r.state === 'completed')).toBe(true);
    await redis.del(`debounce:process-cash-holdings:tenant:${tenantId}`);
  });

  it('a deduplicated add never resets an active entry back to queued', async () => {
    const tenantId = `act-${RUN}-dedup`;
    const portfolio = makeQueue('portfolio');
    let release;
    const gate = new Promise((r) => { release = r; });
    let active;
    const isActive = new Promise((r) => { active = r; });
    makeWorker('portfolio', async (job) => {
      if (job.data.tenantId === tenantId) {
        active();
        await gate;
      }
    });

    const first = await portfolio.add('value-all-assets', { tenantId }, fullValuationDedupOpts(tenantId));
    await isActive;
    await waitFor(tenantId, (s) => s.inFlight[0]?.state === 'running');

    const second = await portfolio.add('value-all-assets', { tenantId }, fullValuationDedupOpts(tenantId));
    expect(second.id).toBe(first.id);
    await new Promise((r) => setTimeout(r, 50));
    const snap = await snapshot(tenantId);
    expect(snap.inFlight).toHaveLength(1);
    expect(snap.inFlight[0].state).toBe('running');

    release();
    await waitFor(tenantId, (s) => s.inFlight.length === 0 && s.recent.length === 1);
  });

  it('AC8: a failure shows only after the final attempt, with an error code', async () => {
    const tenantId = `act-${RUN}-fail`;
    const analytics = makeQueue('analytics');
    const states = [];
    makeWorker('analytics', async (job) => {
      if (job.data.tenantId !== tenantId) return;
      states.push((await snapshot(tenantId)).inFlight[0]?.state);
      throw Object.assign(new Error('deadlock on 1234.56'), { code: 'P2034' });
    });

    await analytics.add('full-rebuild-analytics', { tenantId }, { attempts: 2, backoff: { type: 'fixed', delay: 20 } });
    const snap = await waitFor(tenantId, (s) => s.recent.length === 1);
    expect(snap.inFlight).toHaveLength(0);
    expect(snap.recent[0]).toMatchObject({ state: 'failed', errorCode: 'P2034', type: 'ANALYTICS_UPDATE' });
    expect(snap.summary.ANALYTICS_UPDATE).toMatchObject({ state: 'failed', errorCode: 'P2034' });
    expect(JSON.stringify(await redis.hgetall(activityKey(tenantId)))).not.toContain('deadlock');
    // While retrying, the entry was running — never failed.
    expect(states.length).toBe(2);
    expect(states.every((s) => s === 'running')).toBe(true);
  });
});
