// ─── activityTracker.test.js ────────────────────────────────────────────────
// Unit tests for the processing-status tracker (#100). The Lua write script
// itself runs against a real Redis in integration/activityChain.test.js; here
// the Redis client is a recording fake so every write can be inspected.
//
// The key invariants:
//   - a tracker failure (sync throw, rejected promise) never escapes: every
//     hook returns normally and only `logger.warn` is called (AC10);
//   - a failure is recorded only on the FINAL attempt (AC8);
//   - progress is throttled to one write per job per 2 s, 100 % always passes (AC5);
//   - no error message is ever stored, only a stable code.

const { EventEmitter } = require('events');

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const logger = require('../../../utils/logger');
const tracker = require('../../../utils/activityTracker');

const TENANT = 'tenant-1';

/** ioredis-compatible fake: `defineCommand` installs a recording `activityWrite`. */
function makeClient(impl = () => Promise.resolve(1)) {
  const client = { writes: [] };
  client.defineCommand = jest.fn((name) => {
    client[name] = jest.fn((...args) => {
      const [key, last, field, json, mode, type, completedAt] = args;
      client.writes.push({ key, last, field, entry: json ? JSON.parse(json) : null, mode, type, completedAt });
      return impl(...args);
    });
  });
  return client;
}

function makeJob(overrides = {}) {
  return {
    id: 'j1',
    name: 'value-all-assets',
    data: { tenantId: TENANT },
    timestamp: 1_000,
    attemptsMade: 0,
    opts: { attempts: 3 },
    ...overrides,
  };
}

function makeWorker() {
  return new EventEmitter();
}

let client;

beforeEach(() => {
  jest.clearAllMocks();
  client = makeClient();
  tracker.__setClientForTests(client);
});

afterAll(() => tracker.__setClientForTests(null));

describe('trackQueue', () => {
  it('writes a queued entry for a tenant job on add', () => {
    const queue = Object.assign(new EventEmitter(), { name: 'portfolio' });
    tracker.trackQueue(queue);
    queue.emit('waiting', makeJob());

    expect(client.writes).toHaveLength(1);
    const [w] = client.writes;
    expect(w.key).toBe(`activity:v1:${TENANT}`);
    expect(w.last).toBe(`activity:v1:${TENANT}:last`);
    expect(w.field).toBe('portfolio:j1');
    expect(w.mode).toBe('queued');
    expect(w.entry).toMatchObject({
      t: 'PORTFOLIO_UPDATE', s: 'valuing_assets', st: 'queued', tr: 'user_change', af: ['PORTFOLIO_UPDATE'], lg: 1, sa: 1_000,
    });
    expect(w.entry.ra).toBeUndefined();
  });

  it('ignores tenant-less jobs (nightly fan-outs) and unknown names', () => {
    const queue = Object.assign(new EventEmitter(), { name: 'portfolio' });
    tracker.trackQueue(queue);
    queue.emit('waiting', makeJob({ name: 'revalue-all-tenants', data: {} }));
    queue.emit('waiting', makeJob({ name: 'not-a-job' }));
    expect(client.writes).toHaveLength(0);
  });

  it('attaches only once per queue', () => {
    const queue = Object.assign(new EventEmitter(), { name: 'portfolio' });
    tracker.trackQueue(queue);
    tracker.trackQueue(queue);
    expect(queue.listenerCount('waiting')).toBe(1);
  });

  it('tolerates a mocked queue without `on`', () => {
    expect(() => tracker.trackQueue({})).not.toThrow();
    expect(() => tracker.trackQueue(undefined)).not.toThrow();
  });
});

describe('trackWorker', () => {
  it('marks running on active, with the processing time', () => {
    const worker = makeWorker();
    tracker.trackWorker(worker, 'analytics');
    worker.emit('active', makeJob({ name: 'full-rebuild-analytics', processedOn: 2_000 }));

    const [w] = client.writes;
    expect(w.mode).toBe('update');
    expect(w.entry).toMatchObject({ t: 'ANALYTICS_UPDATE', s: 'updating_analytics', st: 'running', ra: 2_000, lg: 1 });
  });

  it('marks completed with finishedAt and stamps lastCompletedAt', () => {
    const worker = makeWorker();
    tracker.trackWorker(worker, 'portfolio');
    worker.emit('completed', makeJob({ processedOn: 2_000, finishedOn: 5_000 }));

    const [w] = client.writes;
    expect(w.mode).toBe('terminal');
    expect(w.entry).toMatchObject({ st: 'completed', fa: 5_000, p: 100 });
    expect(w.completedAt).toBe(new Date(5_000).toISOString());
    expect(w.type).toBe('PORTFOLIO_UPDATE');
  });

  it('drops ephemeral event entries on completion instead of keeping history', () => {
    const worker = makeWorker();
    tracker.trackWorker(worker, 'events');
    worker.emit('completed', makeJob({ name: 'MANUAL_TRANSACTION_MODIFIED', id: 'e1' }));
    expect(client.writes).toEqual([expect.objectContaining({ field: 'events:e1', mode: 'drop' })]);
  });

  it('records nothing on an intermediate failed attempt (AC8)', () => {
    const worker = makeWorker();
    tracker.trackWorker(worker, 'portfolio');
    worker.emit('failed', makeJob({ attemptsMade: 1 }), new Error('boom'));
    expect(client.writes).toHaveLength(0);
  });

  it('records failed + errorCode on the final attempt, never the message (AC8)', () => {
    const worker = makeWorker();
    tracker.trackWorker(worker, 'portfolio');
    const err = Object.assign(new Error('secret description 123.45'), { code: 'P2034' });
    worker.emit('failed', makeJob({ attemptsMade: 3, finishedOn: 9_000 }), err);

    const [w] = client.writes;
    expect(w.mode).toBe('terminal');
    expect(w.entry).toMatchObject({ st: 'failed', ec: 'P2034', fa: 9_000, at: 3 });
    expect(w.completedAt).toBe('');
    expect(JSON.stringify(w.entry)).not.toContain('secret');
  });

  it('a later success after an intermediate failure is completed', () => {
    const worker = makeWorker();
    tracker.trackWorker(worker, 'portfolio');
    worker.emit('failed', makeJob({ attemptsMade: 1 }), new Error('blip'));
    worker.emit('active', makeJob({ attemptsMade: 1 }));
    worker.emit('completed', makeJob({ attemptsMade: 1 }));
    expect(client.writes.map((w) => w.entry.st)).toEqual(['running', 'completed']);
  });

  it('ignores a failed event without a job', () => {
    const worker = makeWorker();
    tracker.trackWorker(worker, 'portfolio');
    expect(() => worker.emit('failed', undefined, new Error('x'))).not.toThrow();
    expect(client.writes).toHaveLength(0);
  });
});

describe('progress', () => {
  beforeEach(() => jest.useFakeTimers({ now: 10_000 }));
  afterEach(() => jest.useRealTimers());

  it('throttles to one write per 2 s per job and always lets 100 % through (AC5)', () => {
    const job = makeJob();
    const report = tracker.createProgressReporter(job, 'portfolio');

    report(1, 10); // 10 % — written
    report(2, 10); // throttled
    report(3, 10); // throttled
    jest.advanceTimersByTime(2_000);
    report(5, 10); // 50 % — written
    report(10, 10); // 100 % — always written

    const progress = client.writes.map((w) => w.entry.p);
    expect(progress).toEqual([10, 50, 100]);
    expect(client.writes.every((w) => w.entry.st === 'running')).toBe(true);
  });

  it('is monotonically increasing for a valuation-style loop', () => {
    const job = makeJob();
    const report = tracker.createProgressReporter(job, 'portfolio');
    for (let i = 0; i < 20; i++) {
      report(i, 20);
      jest.advanceTimersByTime(2_500);
    }
    const progress = client.writes.map((w) => w.entry.p);
    expect(progress.length).toBeGreaterThan(5);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  });

  it('surfaces BullMQ updateProgress via the worker progress event', () => {
    const worker = makeWorker();
    tracker.trackWorker(worker, 'smart-import');
    worker.emit('progress', makeJob({ name: 'commit-smart-import' }), 42.4);
    worker.emit('progress', makeJob({ id: 'j2', name: 'commit-smart-import' }), { stage: 'x' }); // non-numeric ignored
    expect(client.writes).toHaveLength(1);
    expect(client.writes[0].entry).toMatchObject({ t: 'IMPORT', s: 'committing', p: 42 });
  });

  it('ignores invalid totals', () => {
    const report = tracker.createProgressReporter(makeJob(), 'portfolio');
    report(1, 0);
    report(NaN, 5);
    expect(client.writes).toHaveLength(0);
  });
});

describe('failure isolation (AC10)', () => {
  const fire = () => {
    const queue = Object.assign(new EventEmitter(), { name: 'portfolio' });
    tracker.trackQueue(queue);
    const worker = makeWorker();
    tracker.trackWorker(worker, 'portfolio');
    const job = makeJob({ attemptsMade: 3 });
    queue.emit('waiting', job);
    worker.emit('active', job);
    worker.emit('progress', job, 50);
    tracker.createProgressReporter(job, 'portfolio')(10, 10);
    worker.emit('completed', job);
    worker.emit('failed', job, new Error('x'));
    tracker.dropEntry(TENANT, 'portfolio', 'j9');
    const inline = tracker.startInlineActivity({ queueName: 'insights', id: 'cron:t', tenantId: TENANT, jobName: 'generate-tenant-insights' });
    inline.complete();
    inline.fail(new Error('x'));
  };

  it('swallows a synchronous throw from the Redis client', () => {
    tracker.__setClientForTests(makeClient(() => { throw new Error('redis down'); }));
    expect(fire).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('swallows a rejected write', async () => {
    tracker.__setClientForTests(makeClient(() => Promise.reject(new Error('READONLY'))));
    expect(fire).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('swallows a client whose defineCommand throws', () => {
    tracker.__setClientForTests({ defineCommand: () => { throw new Error('no scripting'); } });
    expect(fire).not.toThrow();
  });

  it('hook functions return synchronously (nothing to await)', () => {
    const report = tracker.createProgressReporter(makeJob(), 'portfolio');
    expect(report(1, 2)).toBeUndefined();
    expect(tracker.dropEntry(TENANT, 'portfolio', 'x')).toBeUndefined();
  });
});

describe('dropEntry / startInlineActivity', () => {
  it('drops a removed job entry', () => {
    tracker.dropEntry(TENANT, 'portfolio', 'uuid-1');
    expect(client.writes).toEqual([expect.objectContaining({ field: 'portfolio:uuid-1', mode: 'drop', entry: null })]);
  });

  it('skips a missing job id', () => {
    tracker.dropEntry(TENANT, 'portfolio', undefined);
    expect(client.writes).toHaveLength(0);
  });

  it('tracks inline per-tenant work as nightly', () => {
    const activity = tracker.startInlineActivity({ queueName: 'insights', id: 'cron-1:t1', tenantId: TENANT, jobName: 'generate-portfolio-intel' });
    activity.complete();
    expect(client.writes.map((w) => [w.field, w.mode, w.entry.st, w.entry.tr])).toEqual([
      ['insights:cron-1:t1', 'update', 'running', 'nightly'],
      ['insights:cron-1:t1', 'terminal', 'completed', 'nightly'],
    ]);
  });

  it('an inline failure is final', () => {
    const activity = tracker.startInlineActivity({ queueName: 'insights', id: 'cron-1:t1', tenantId: TENANT, jobName: 'generate-tenant-insights' });
    activity.fail(new Error('LLM request timed out'));
    expect(client.writes[1].entry).toMatchObject({ st: 'failed', ec: 'LLM_TIMEOUT' });
  });
});

describe('resolveTrigger', () => {
  const { resolveTrigger } = tracker;

  it.each([
    ['manual rebuild wins', 'portfolio', { data: { tenantId: 't', _rebuildMeta: {}, _trigger: 'agent' } }, 'manual_rebuild'],
    ['propagated trigger', 'analytics', { data: { tenantId: 't', _trigger: 'agent' } }, 'agent'],
    ['unknown propagated value is ignored', 'analytics', { data: { tenantId: 't', _trigger: 'evil' } }, 'user_change'],
    ['nightly jobId prefix', 'portfolio', { id: 'nightly-revalue-t-2026-10-04-valuation', data: { tenantId: 't' } }, 'nightly'],
    ['nightly cron source', 'subscription-detection', { data: { tenantId: 't', source: 'nightly-cron' } }, 'nightly'],
    ['plaid queue', 'plaid-sync', { data: { tenantId: 't' } }, 'bank_sync'],
    ['plaid source', 'events', { name: 'TRANSACTIONS_IMPORTED', data: { tenantId: 't', source: 'PLAID_PROMOTE' } }, 'bank_sync'],
    ['plaid event name', 'events', { name: 'PLAID_SYNC_UPDATES', data: { tenantId: 't' } }, 'bank_sync'],
    ['smart import queue', 'smart-import', { data: { tenantId: 't' } }, 'import'],
    ['import source', 'events', { name: 'TRANSACTIONS_IMPORTED', data: { tenantId: 't', source: 'SMART_IMPORT' } }, 'import'],
    ['stale-history revaluation (a page view)', 'events', { name: 'PORTFOLIO_STALE_REVALUATION', data: { tenantId: 't' } }, 'auto_refresh'],
    ['default', 'events', { name: 'MANUAL_TRANSACTION_MODIFIED', data: { tenantId: 't', source: 'MANUAL' } }, 'user_change'],
  ])('%s', (_label, queue, job, expected) => {
    expect(resolveTrigger(queue, job)).toBe(expected);
  });

  it('carryOrigin forwards the run id always, the trigger only when not a plain user change', () => {
    expect(tracker.carryOrigin('events', { id: '1', name: 'PLAID_SYNC_UPDATES', data: { tenantId: 't' } }))
      .toEqual({ _run: 'events:1', _trigger: 'bank_sync' });
    expect(tracker.carryOrigin('events', { id: '2', name: 'MANUAL_TRANSACTION_CREATED', data: { tenantId: 't' } }))
      .toEqual({ _run: 'events:2' });
    expect(tracker.carryOrigin('events', { id: '3', name: 'MANUAL_REBUILD_REQUESTED', data: { tenantId: 't', _rebuildMeta: {} } }))
      .toEqual({ _run: 'events:3' });
    // A propagated run id wins over the job's own: the whole chain is one run.
    expect(tracker.carryOrigin('portfolio', { id: '4', name: 'X', data: { tenantId: 't', _trigger: 'agent', _run: 'events:1' } }))
      .toEqual({ _run: 'events:1', _trigger: 'agent' });
    expect(tracker.carryOrigin('events', { id: '5', name: 'PORTFOLIO_STALE_REVALUATION', data: { tenantId: 't' } }))
      .toEqual({ _run: 'events:5', _trigger: 'auto_refresh' });
  });

  it('stamps every entry with its run id (rn)', () => {
    const queue = Object.assign(new EventEmitter(), { name: 'portfolio' });
    tracker.trackQueue(queue);
    queue.emit('waiting', makeJob({ id: 'a' }));
    queue.emit('waiting', makeJob({ id: 'b', data: { tenantId: TENANT, _run: 'events:9' } }));
    expect(client.writes.map((w) => w.entry.rn)).toEqual(['portfolio:a', 'events:9']);
  });
});

describe('classifyError', () => {
  const { classifyError } = tracker;
  it.each([
    [{ code: 'P2034' }, 'P2034'],
    [{ code: 'ECONNRESET' }, 'ECONNRESET'],
    [new Error('Gemini classification request timed out'), 'LLM_TIMEOUT'],
    [new Error('Query timeout after 30s'), 'TIMEOUT'],
    [new Error('anything else'), 'INTERNAL'],
    [undefined, 'INTERNAL'],
  ])('%p → %s', (err, code) => {
    expect(classifyError(err)).toBe(code);
  });
});

describe('disabled by default in tests', () => {
  it('does not open a connection without an injected client', () => {
    tracker.__setClientForTests(null);
    const queue = Object.assign(new EventEmitter(), { name: 'portfolio' });
    tracker.trackQueue(queue);
    expect(() => queue.emit('waiting', makeJob())).not.toThrow();
  });
});
