/**
 * Processing-status tracker (#100) — the only writer of the per-tenant
 * activity hash read by `GET /api/activity` (see `@bliss/shared/activity`).
 *
 * Hooks, not handler changes:
 *   - `trackQueue(queue)`   once per queue factory: a `queued` entry on every add
 *     (BullMQ emits `'waiting'` for immediate, delayed and deduplicated adds).
 *   - `trackWorker(worker)` once per worker: `running` on `'active'`, progress on
 *     `'progress'`, `completed` / `failed` on the terminal events. A failure is
 *     only recorded on the FINAL attempt (same rule as `reportWorkerFailure`).
 *   - `createProgressReporter(job, queueName)` for handlers that report
 *     `done / total` without touching BullMQ.
 *   - `dropEntry()` for jobs removed before they ran (the debounce service).
 *   - `startInlineActivity()` for per-tenant work done inline by a tenant-less
 *     cron job (nightly insights).
 *
 * Safety (non-negotiable, enforced by tests):
 *   - Every public function is synchronous fire-and-forget: it never throws,
 *     never returns a promise a caller could await, and logs Redis errors at
 *     `warn`. A tracker failure can never fail, retry or slow a job.
 *   - A dedicated ioredis connection with `maxRetriesPerRequest: 1` and no
 *     offline queue, so an unhealthy Redis drops status writes instead of
 *     queueing them behind BullMQ's `maxRetriesPerRequest: null` connection.
 *   - No Prisma, no BullMQ write API. Records carry no PII or amounts: failures
 *     store a stable `errorCode`, never the error message.
 */

const Redis = require('ioredis');
const {
    ACTIVITY_STATES,
    TRIGGERS,
    TRIGGER_LIST,
    RETENTION_MS,
    RETENTION_SECONDS,
    PRUNE_THRESHOLD,
    MAX_ENTRIES,
    PROGRESS_THROTTLE_MS,
    activityKey,
    lastKey,
} = require('@bliss/shared/activity');
const { resolveActivity, QUEUES } = require('../config/activityMap');
const { isFinalAttempt } = require('./workerFailureReporter');
const logger = require('./logger');

/**
 * One round-trip per write. KEYS: activity hash, last-completed hash.
 * ARGV: field, entry JSON, mode (queued|update|terminal|drop), type,
 * completedAt ISO ('' unless completed), ttl s, now ms, retention ms,
 * prune threshold, max entries.
 *
 *  - queued:   HSETNX semantics, so a deduplicated add (same job id) never
 *              resets an active entry back to queued.
 *  - update /
 *    terminal: never overwrite a finished entry (a late progress write can't
 *              resurrect a completed job).
 *  - terminal: also stamps `:last` (completed only) and prunes the hash once
 *              it outgrows PRUNE_THRESHOLD: entries older than the retention
 *              first, then the oldest finished ones down to MAX_ENTRIES.
 */
const WRITE_SCRIPT = `
local mode = ARGV[3]
if mode == 'drop' then
  return redis.call('HDEL', KEYS[1], ARGV[1])
end
local existing = redis.call('HGET', KEYS[1], ARGV[1])
if existing then
  if mode == 'queued' then return 0 end
  local ok, cur = pcall(cjson.decode, existing)
  if ok and type(cur) == 'table' and (cur.st == 'completed' or cur.st == 'failed') then return 0 end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[6]))
if mode == 'terminal' then
  if ARGV[5] ~= '' then redis.call('HSET', KEYS[2], ARGV[4], ARGV[5]) end
  if redis.call('HLEN', KEYS[1]) > tonumber(ARGV[9]) then
    local cutoff = tonumber(ARGV[7]) - tonumber(ARGV[8])
    local all = redis.call('HGETALL', KEYS[1])
    local count = #all / 2
    local finished = {}
    for i = 1, #all, 2 do
      local okd, e = pcall(cjson.decode, all[i + 1])
      if not okd or type(e) ~= 'table' then
        redis.call('HDEL', KEYS[1], all[i]); count = count - 1
      else
        local ts = tonumber(e.fa) or tonumber(e.ua) or tonumber(e.sa) or 0
        if ts < cutoff then
          redis.call('HDEL', KEYS[1], all[i]); count = count - 1
        elseif e.st == 'completed' or e.st == 'failed' then
          table.insert(finished, { all[i], ts })
        end
      end
    end
    local max = tonumber(ARGV[10])
    if count > max then
      table.sort(finished, function(a, b) return a[2] < b[2] end)
      for i = 1, math.min(count - max, #finished) do
        redis.call('HDEL', KEYS[1], finished[i][1])
      end
    end
  end
end
return 1
`;

let client = null;
let clientOverride = null;
let lastErrorLogAt = 0;

/** Per-job progress throttle state: `${queue}:${jobId}` → last write epoch ms. */
const progressWrites = new Map();

function warnThrottled(message, meta) {
    const now = Date.now();
    if (now - lastErrorLogAt < 30_000) return;
    lastErrorLogAt = now;
    logger.warn(message, meta);
}

function isEnabled() {
    if (clientOverride) return true;
    if (process.env.ACTIVITY_TRACKING === 'false') return false;
    // Unit tests never open a real connection; tests inject a client instead.
    if (process.env.NODE_ENV === 'test') return false;
    return Boolean(process.env.REDIS_URL);
}

function getClient() {
    if (clientOverride) return clientOverride;
    if (!isEnabled()) return null;
    if (!client) {
        client = new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
            enableReadyCheck: false,
            connectionName: 'bliss-activity-tracker',
            retryStrategy: (times) => Math.min(times * 500, 10_000),
        });
        client.on('error', (error) => {
            warnThrottled('[activity] tracker Redis connection error', { error: error?.message });
        });
    }
    return client;
}

function ensureCommand(redis) {
    if (typeof redis.activityWrite !== 'function') {
        redis.defineCommand('activityWrite', { numberOfKeys: 2, lua: WRITE_SCRIPT });
    }
}

/**
 * Fire one write. Never throws and never returns the promise: callers are
 * BullMQ event listeners and job handlers that must not wait on, or be
 * failed by, a status write.
 */
function send(tenantId, field, entry, mode, completedAt = '') {
    try {
        const redis = getClient();
        if (!redis || !tenantId || !field) return;
        ensureCommand(redis);
        const now = Date.now();
        const pending = redis.activityWrite(
            activityKey(tenantId),
            lastKey(tenantId),
            field,
            entry ? JSON.stringify(entry) : '',
            mode,
            entry?.t || '',
            completedAt,
            String(RETENTION_SECONDS),
            String(now),
            String(RETENTION_MS),
            String(PRUNE_THRESHOLD),
            String(MAX_ENTRIES),
        );
        if (pending && typeof pending.catch === 'function') {
            pending.catch((error) => {
                warnThrottled('[activity] status write failed (ignored)', { mode, error: error?.message });
            });
        }
    } catch (error) {
        warnThrottled('[activity] status write failed (ignored)', { mode, error: error?.message });
    }
}

// ── Classification helpers ──────────────────────────────────────────────────

const PLAID_SOURCES = new Set(['INITIAL', 'INITIAL_SYNC', 'SYNC_UPDATE', 'SYNC_UPDATES', 'SYNCED', 'HISTORICAL_BACKFILL', 'MANUAL_RETRY', 'MANUAL_RESYNC', 'RECONNECT_SYNC']);
const IMPORT_SOURCES = new Set(['CSV', 'SMART_IMPORT']);

/**
 * Who started this work. Checked in order: an admin rebuild, a propagated
 * `_trigger`, the nightly crons, bank sync, import, otherwise a user change.
 */
function resolveTrigger(queueName, job) {
    const data = job?.data || {};
    if (data._rebuildMeta) return TRIGGERS.MANUAL_REBUILD;
    if (TRIGGER_LIST.includes(data._trigger)) return data._trigger;

    const jobId = String(job?.id || '');
    const source = typeof data.source === 'string' ? data.source : '';
    if (jobId.startsWith('nightly-') || /cron/i.test(source)) return TRIGGERS.NIGHTLY;

    if (queueName === QUEUES.PLAID_SYNC || queueName === QUEUES.PLAID_PROCESSING
        || /plaid/i.test(source) || PLAID_SOURCES.has(source) || (job?.name || '').startsWith('PLAID_')) {
        return TRIGGERS.BANK_SYNC;
    }
    if (queueName === QUEUES.SMART_IMPORT || (job?.name || '').startsWith('SMART_IMPORT_') || IMPORT_SOURCES.has(source)) {
        return TRIGGERS.IMPORT;
    }
    return TRIGGERS.USER_CHANGE;
}

/** A stable error code. The message is never stored — it can contain PII. */
function classifyError(error) {
    const code = typeof error?.code === 'string' ? error.code : '';
    if (/^P\d{4}$/.test(code)) return code;
    if (/^E[A-Z]+$/.test(code)) return code;
    const name = String(error?.name || '');
    const message = String(error?.message || '');
    if (/timeout|timed out/i.test(name) || /timeout|timed out/i.test(message)) {
        return /llm|gemini|openai|anthropic|classif|insight/i.test(message) ? 'LLM_TIMEOUT' : 'TIMEOUT';
    }
    return 'INTERNAL';
}

const fieldFor = (queueName, job) => (job?.id !== undefined && job?.id !== null ? `${queueName}:${job.id}` : null);

function clampProgress(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.max(0, Math.min(100, Math.round(value)));
}

function buildEntry(queueName, job, info, state, extra = {}) {
    const now = Date.now();
    const entry = {
        t: info.type,
        s: info.stage,
        st: state,
        p: extra.progress ?? null,
        tr: resolveTrigger(queueName, job),
        af: info.affects,
        sa: Number.isFinite(job?.timestamp) ? job.timestamp : now,
        ua: now,
    };
    if (info.long) entry.lg = 1;
    if (state !== ACTIVITY_STATES.QUEUED) entry.ra = Number.isFinite(job?.processedOn) ? job.processedOn : now;
    if (Number.isFinite(job?.attemptsMade) && job.attemptsMade > 0) entry.at = job.attemptsMade;
    return Object.assign(entry, extra.fields || {});
}

function resolveSafely(queueName, job) {
    try {
        return resolveActivity(queueName, job);
    } catch {
        return null;
    }
}

// ── Writers ─────────────────────────────────────────────────────────────────

function markQueued(queueName, job) {
    try {
        const info = resolveSafely(queueName, job);
        if (!info) return;
        send(job.data.tenantId, fieldFor(queueName, job), buildEntry(queueName, job, info, ACTIVITY_STATES.QUEUED), 'queued');
    } catch (error) {
        warnThrottled('[activity] markQueued failed (ignored)', { error: error?.message });
    }
}

function markRunning(queueName, job, progress = null) {
    try {
        const info = resolveSafely(queueName, job);
        if (!info) return;
        send(job.data.tenantId, fieldFor(queueName, job), buildEntry(queueName, job, info, ACTIVITY_STATES.RUNNING, { progress }), 'update');
    } catch (error) {
        warnThrottled('[activity] markRunning failed (ignored)', { error: error?.message });
    }
}

function writeProgress(queueName, job, value) {
    try {
        const progress = clampProgress(value);
        if (progress === null) return;
        const field = fieldFor(queueName, job);
        if (!field) return;
        const now = Date.now();
        const last = progressWrites.get(field) || 0;
        if (progress < 100 && now - last < PROGRESS_THROTTLE_MS) return;
        progressWrites.set(field, now);
        markRunning(queueName, job, progress);
    } catch (error) {
        warnThrottled('[activity] progress write failed (ignored)', { error: error?.message });
    }
}

function markCompleted(queueName, job) {
    try {
        const info = resolveSafely(queueName, job);
        if (!info) return;
        const field = fieldFor(queueName, job);
        progressWrites.delete(field);
        // Event hops only bridge two jobs of a chain: once routed they leave
        // no history row (they'd drown the 24 h list in "Scheduling").
        if (info.ephemeral) {
            send(job.data.tenantId, field, null, 'drop');
            return;
        }
        const finishedAt = Number.isFinite(job?.finishedOn) ? job.finishedOn : Date.now();
        const entry = buildEntry(queueName, job, info, ACTIVITY_STATES.COMPLETED, { progress: 100, fields: { fa: finishedAt } });
        send(job.data.tenantId, field, entry, 'terminal', new Date(finishedAt).toISOString());
    } catch (error) {
        warnThrottled('[activity] markCompleted failed (ignored)', { error: error?.message });
    }
}

function markFailed(queueName, job, error) {
    try {
        const info = resolveSafely(queueName, job);
        if (!info) return;
        // Intermediate attempts stay `running`: BullMQ will retry them.
        if (!isFinalAttempt(job)) return;
        const field = fieldFor(queueName, job);
        progressWrites.delete(field);
        const finishedAt = Number.isFinite(job?.finishedOn) ? job.finishedOn : Date.now();
        const entry = buildEntry(queueName, job, info, ACTIVITY_STATES.FAILED, {
            progress: null,
            fields: { fa: finishedAt, ec: classifyError(error) },
        });
        send(job.data.tenantId, field, entry, 'terminal', '');
    } catch (err) {
        warnThrottled('[activity] markFailed failed (ignored)', { error: err?.message });
    }
}

// ── Public hooks ────────────────────────────────────────────────────────────

/** Attach once, right after a queue is created. */
function trackQueue(queue) {
    try {
        if (!queue || typeof queue.on !== 'function' || queue.__activityTracked) return queue;
        queue.__activityTracked = true;
        queue.on('waiting', (job) => markQueued(queue.name, job));
    } catch (error) {
        warnThrottled('[activity] trackQueue failed (ignored)', { error: error?.message });
    }
    return queue;
}

/** Attach once, next to the worker's existing `on('failed')`. */
function trackWorker(worker, queueName = worker?.name) {
    try {
        if (!worker || typeof worker.on !== 'function') return worker;
        worker.on('active', (job) => markRunning(queueName, job));
        worker.on('progress', (job, progress) => writeProgress(queueName, job, progress));
        worker.on('completed', (job) => markCompleted(queueName, job));
        worker.on('failed', (job, error) => markFailed(queueName, job, error));
    } catch (error) {
        warnThrottled('[activity] trackWorker failed (ignored)', { error: error?.message });
    }
    return worker;
}

/**
 * `(done, total) => void` — reports `done / total` as a percentage for this
 * job, throttled to one write per job per PROGRESS_THROTTLE_MS (100 % is
 * always written). Attach it as an own property (`job.reportProgress = …`) so
 * it survives the `{ ...job, data }` spread handlers use.
 */
function createProgressReporter(job, queueName) {
    return (done, total) => {
        try {
            if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return;
            writeProgress(queueName, job, (done / total) * 100);
        } catch {
            // never throw into a handler
        }
    };
}

/** Remove the entry of a job that was removed before it ran (debounce replace). */
function dropEntry(tenantId, queueName, jobId) {
    if (jobId === undefined || jobId === null) return;
    send(tenantId, `${queueName}:${jobId}`, null, 'drop');
}

/**
 * Track per-tenant work a tenant-less cron job does inline (no child job).
 * Returns `{ complete(), fail(error) }`; both are fire-and-forget.
 */
function startInlineActivity({ queueName, id, tenantId, jobName, trigger = TRIGGERS.NIGHTLY }) {
    const job = { id, name: jobName, data: { tenantId, _trigger: trigger }, timestamp: Date.now(), processedOn: Date.now() };
    markRunning(queueName, job);
    return {
        complete: () => markCompleted(queueName, { ...job, finishedOn: Date.now() }),
        fail: (error) => markFailed(queueName, { ...job, finishedOn: Date.now(), attemptsMade: 1, opts: { attempts: 1 } }, error),
    };
}

/**
 * The `_trigger` to forward into downstream jobs and events, so a chain
 * started by a nightly cron, an AI agent, a bank sync or an import keeps its
 * label end to end. `{}` for user changes and admin rebuilds (`_rebuildMeta`
 * already travels on its own).
 */
function carryTrigger(queueName, job) {
    try {
        const trigger = resolveTrigger(queueName, job);
        if (trigger === TRIGGERS.USER_CHANGE || trigger === TRIGGERS.MANUAL_REBUILD) return {};
        return { _trigger: trigger };
    } catch {
        return {};
    }
}

async function closeActivityTracker() {
    const c = client;
    client = null;
    if (c) {
        try {
            await c.quit();
        } catch {
            c.disconnect();
        }
    }
}

/** Tests only: route writes to the given ioredis-compatible client (null to reset). */
function __setClientForTests(redis) {
    clientOverride = redis;
    progressWrites.clear();
    lastErrorLogAt = 0;
}

module.exports = {
    trackQueue,
    trackWorker,
    createProgressReporter,
    dropEntry,
    startInlineActivity,
    carryTrigger,
    resolveTrigger,
    classifyError,
    closeActivityTracker,
    WRITE_SCRIPT,
    __setClientForTests,
};
