/**
 * @bliss/shared/activity — the processing-status contract (#100).
 *
 * Every background job that works on a tenant's data (portfolio, analytics,
 * bank sync, import, …) leaves one small entry in a per-tenant Redis hash. The
 * backend `activityTracker` (CJS) is the only writer; the API reads the hash in
 * one pipeline and turns it into the `GET /api/activity` payload with the pure
 * `summarize()` below. Both sides import the keys and constants from here so
 * they can never drift.
 *
 * Redis layout (no Postgres, no migration):
 *   activity:v1:{tenantId}        HASH  `{queue}:{jobId}` → JSON entry (24 h TTL, refreshed on write)
 *   activity:v1:{tenantId}:last   HASH  activity type → ISO lastCompletedAt (no TTL)
 *   bliss:runtime:worker          the existing worker heartbeat (180 s TTL)
 *
 * Entry (short keys keep the hash small):
 *   t  type        s  stage       st state (queued|running|completed|failed)
 *   p  progress    tr trigger     af affects[]     lg long-running (60 min stall clock)
 *   sa enqueued at ra running at  ua updated at    fa finished at   (epoch ms)
 *   ec errorCode   at attempt
 *
 * `stalled` is never written: it is derived here, on read, from `ua`.
 * Nothing in the system acts on it — it is a display state only.
 */

export const ACTIVITY_VERSION = 'v1';

export const ACTIVITY_TYPES = Object.freeze({
    PORTFOLIO_UPDATE: 'PORTFOLIO_UPDATE',
    ANALYTICS_UPDATE: 'ANALYTICS_UPDATE',
    BANK_SYNC: 'BANK_SYNC',
    IMPORT: 'IMPORT',
    SECURITY_DATA: 'SECURITY_DATA',
    SUBSCRIPTION_SCAN: 'SUBSCRIPTION_SCAN',
    INSIGHTS: 'INSIGHTS',
});

export const ACTIVITY_TYPE_LIST = Object.freeze(Object.values(ACTIVITY_TYPES));

export const ACTIVITY_STATES = Object.freeze({
    QUEUED: 'queued',
    RUNNING: 'running',
    STALLED: 'stalled',
    COMPLETED: 'completed',
    FAILED: 'failed',
});

export const TERMINAL_STATES = Object.freeze([ACTIVITY_STATES.COMPLETED, ACTIVITY_STATES.FAILED]);

export const TRIGGERS = Object.freeze({
    USER_CHANGE: 'user_change',
    BANK_SYNC: 'bank_sync',
    IMPORT: 'import',
    NIGHTLY: 'nightly',
    MANUAL_REBUILD: 'manual_rebuild',
    AGENT: 'agent',
    /** The on-access stale-history revaluation (a page view, not an edit). */
    AUTO_REFRESH: 'auto_refresh',
});

export const TRIGGER_LIST = Object.freeze(Object.values(TRIGGERS));

/** Stage keys. The web app translates them (`activity.stages.<key>`). */
export const STAGES = Object.freeze({
    SCHEDULING: 'scheduling',
    RECALCULATING_LOTS: 'recalculating_lots',
    UPDATING_CASH: 'updating_cash',
    VALUING_ASSETS: 'valuing_assets',
    UPDATING_DEBTS: 'updating_debts',
    UPDATING_ANALYTICS: 'updating_analytics',
    FETCHING_BANK: 'fetching_bank',
    CLASSIFYING: 'classifying',
    PROCESSING_FILE: 'processing_file',
    COMMITTING: 'committing',
    REFRESHING_MARKET_DATA: 'refreshing_market_data',
    SCANNING: 'scanning',
    GENERATING_INSIGHTS: 'generating_insights',
});

const MINUTE = 60 * 1000;

/**
 * Stall clocks. An in-flight entry whose last update is older than its clock is
 * reported `stalled`. Long-running work (full valuation, full portfolio /
 * analytics rebuild, security data) and anything still `queued` get the long
 * clock: analytics and plaid-processor run at concurrency 1 globally, so a
 * tenant's job can legitimately wait behind the nightly fan-out.
 */
export const STALL_THRESHOLDS_MS = Object.freeze({
    default: 30 * MINUTE,
    long: 60 * MINUTE,
});

/** Entries (and the 24 h history) are kept for a day. */
export const RETENTION_MS = 24 * 60 * MINUTE;
export const RETENTION_SECONDS = RETENTION_MS / 1000;

/** `recent` is capped at this many entries, newest first. */
export const RECENT_LIMIT = 200;

/** The write script starts pruning a tenant's hash above this many fields… */
export const PRUNE_THRESHOLD = 200;
/** …and never lets it grow past this many (oldest finished entries go first). */
export const MAX_ENTRIES = 500;

/**
 * A final failure keeps its activity type red in `summary` until the type
 * completes again, or for this long at most.
 */
export const FAILED_VISIBLE_MS = 60 * MINUTE;

/** Progress writes are throttled to one per job per this interval. */
export const PROGRESS_THROTTLE_MS = 2000;

/** Written by the backend worker heartbeat (`utils/workerHeartbeat.js`). */
export const WORKER_HEARTBEAT_KEY = 'bliss:runtime:worker';

export const activityKey = (tenantId) => `activity:${ACTIVITY_VERSION}:${tenantId}`;
export const lastKey = (tenantId) => `${activityKey(tenantId)}:last`;

const STATE_SEVERITY = {
    [ACTIVITY_STATES.QUEUED]: 1,
    [ACTIVITY_STATES.RUNNING]: 2,
    [ACTIVITY_STATES.STALLED]: 3,
    [ACTIVITY_STATES.FAILED]: 4,
};

const isType = (t) => ACTIVITY_TYPE_LIST.includes(t);
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function parseEntry(id, raw) {
    if (typeof raw !== 'string') return null;
    let e;
    try {
        e = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!e || typeof e !== 'object' || !isType(e.t) || typeof e.st !== 'string') return null;
    return { id, ...e };
}

/** Whether an in-flight entry has outlived its stall clock. */
export function isStalled(entry, now) {
    const threshold = entry.lg || entry.t === ACTIVITY_TYPES.SECURITY_DATA || entry.st === ACTIVITY_STATES.QUEUED
        ? STALL_THRESHOLDS_MS.long
        : STALL_THRESHOLDS_MS.default;
    const updatedAt = num(entry.ua) ?? num(entry.sa) ?? 0;
    return now - updatedAt > threshold;
}

/** The chain an entry belongs to (`rn`, written by the tracker); entries without one stand alone. */
const runOf = (e) => (typeof e.rn === 'string' && e.rn ? e.rn : e.id);

function toInFlight(e, now) {
    const state = isStalled(e, now) ? ACTIVITY_STATES.STALLED : e.st;
    return {
        id: e.id,
        type: e.t,
        stage: e.s || null,
        state,
        progress: num(e.p),
        trigger: e.tr || TRIGGERS.USER_CHANGE,
        affects: Array.isArray(e.af) && e.af.length > 0 ? e.af.filter(isType) : [e.t],
        runId: runOf(e),
        enqueuedAt: iso(num(e.sa)),
        startedAt: iso(num(e.ra) ?? num(e.sa)),
        updatedAt: iso(num(e.ua) ?? num(e.sa)),
    };
}

function toRecent(e) {
    const started = num(e.ra) ?? num(e.sa);
    const finished = num(e.fa) ?? num(e.ua);
    return {
        id: e.id,
        type: e.t,
        stage: e.s || null,
        state: e.st,
        trigger: e.tr || TRIGGERS.USER_CHANGE,
        ...(e.st === ACTIVITY_STATES.FAILED ? { errorCode: e.ec || 'INTERNAL' } : {}),
        runId: runOf(e),
        enqueuedAt: iso(num(e.sa)),
        startedAt: iso(started),
        finishedAt: iso(finished),
        durationMs: started !== null && finished !== null ? Math.max(0, finished - started) : null,
    };
}

/** The payload for a tenant whose status cannot be read (no Redis, Redis down). */
export function unavailable(now = Date.now()) {
    return {
        available: false,
        workerOnline: null,
        serverTime: new Date(now).toISOString(),
        summary: {},
        inFlight: [],
        recent: [],
        runs: [],
        lastCompletedAt: {},
    };
}

/**
 * Group finished entries into runs: one row per edit / sync / import /
 * rebuild / nightly run, with its jobs as steps (oldest first). A run that
 * still has work in flight is left out — it is shown live, not as history.
 */
export function groupRuns(recent, inFlight = []) {
    const live = new Set(inFlight.map((e) => e.runId));
    const runs = new Map();
    for (const step of recent) {
        if (live.has(step.runId)) continue;
        let run = runs.get(step.runId);
        if (!run) {
            run = { id: step.runId, trigger: step.trigger, types: [], steps: [] };
            runs.set(step.runId, run);
        }
        run.steps.push(step);
    }
    const out = [];
    for (const run of runs.values()) {
        run.steps.sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || '') || a.id.localeCompare(b.id));
        for (const step of run.steps) if (!run.types.includes(step.type)) run.types.push(step.type);
        const failed = run.steps.find((s) => s.state === ACTIVITY_STATES.FAILED);
        const starts = run.steps.map((s) => s.startedAt).filter(Boolean).sort();
        const ends = run.steps.map((s) => s.finishedAt).filter(Boolean).sort();
        const startedAt = starts[0] ?? null;
        const finishedAt = ends[ends.length - 1] ?? null;
        out.push({
            id: run.id,
            trigger: run.steps[0].trigger,
            types: run.types,
            state: failed ? ACTIVITY_STATES.FAILED : ACTIVITY_STATES.COMPLETED,
            ...(failed ? { errorCode: failed.errorCode } : {}),
            startedAt,
            finishedAt,
            durationMs: startedAt && finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null,
            steps: run.steps,
        });
    }
    return out.sort((a, b) => (b.finishedAt || '').localeCompare(a.finishedAt || '') || a.id.localeCompare(b.id));
}

/**
 * Turn the raw Redis hashes into the `GET /api/activity` payload.
 *
 * @param {Record<string,string>|null} rawHash   HGETALL activity:v1:{tenantId}
 * @param {Record<string,string>|null} lastHash  HGETALL activity:v1:{tenantId}:last
 * @param {boolean|null} workerOnline            whether the worker heartbeat key exists
 * @param {number} [now]                         epoch ms
 */
export function summarize(rawHash, lastHash, workerOnline, now = Date.now()) {
    const lastCompletedAt = {};
    for (const [type, value] of Object.entries(lastHash || {})) {
        if (isType(type) && typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
            lastCompletedAt[type] = value;
        }
    }

    const inFlightEntries = [];
    const recentEntries = [];
    for (const [id, raw] of Object.entries(rawHash || {})) {
        const e = parseEntry(id, raw);
        if (!e) continue;
        if (TERMINAL_STATES.includes(e.st)) {
            const finished = num(e.fa) ?? num(e.ua) ?? 0;
            if (now - finished <= RETENTION_MS) recentEntries.push(e);
        } else {
            // A non-terminal entry this old is an orphan (its job was removed
            // or lost); the write script prunes it, the reader ignores it.
            const enqueued = num(e.sa) ?? num(e.ua) ?? 0;
            if (now - enqueued <= RETENTION_MS) inFlightEntries.push(e);
        }
    }

    const inFlight = inFlightEntries
        .map((e) => toInFlight(e, now))
        .sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || '') || a.id.localeCompare(b.id));

    const recent = recentEntries
        .map(toRecent)
        .sort((a, b) => (b.finishedAt || '').localeCompare(a.finishedAt || '') || a.id.localeCompare(b.id))
        .slice(0, RECENT_LIMIT);

    // Coalesced per-type view (the header chip): one row per type however
    // many jobs of that type are in flight. Stage / progress / trigger come
    // from the longest-running entry; the state is the most severe one.
    const summary = {};
    for (const item of inFlight) {
        const row = summary[item.type];
        if (!row) {
            summary[item.type] = {
                state: item.state,
                stage: item.stage,
                progress: item.progress,
                count: 1,
                trigger: item.trigger,
                startedAt: item.startedAt,
                affects: [...item.affects],
            };
            continue;
        }
        row.count += 1;
        if (STATE_SEVERITY[item.state] > STATE_SEVERITY[row.state]) row.state = item.state;
        for (const t of item.affects) if (!row.affects.includes(t)) row.affects.push(t);
    }

    // A final failure keeps its type red until the type completes again.
    for (const item of recent) {
        if (item.state !== ACTIVITY_STATES.FAILED || !item.finishedAt) continue;
        const finishedMs = Date.parse(item.finishedAt);
        if (now - finishedMs > FAILED_VISIBLE_MS) continue;
        const last = lastCompletedAt[item.type];
        if (last && Date.parse(last) >= finishedMs) continue;
        const row = summary[item.type];
        if (row) {
            row.state = ACTIVITY_STATES.FAILED;
            row.errorCode = row.errorCode || item.errorCode;
        } else {
            summary[item.type] = {
                state: ACTIVITY_STATES.FAILED,
                stage: item.stage,
                progress: null,
                count: 0,
                trigger: item.trigger,
                startedAt: item.startedAt,
                affects: [item.type],
                errorCode: item.errorCode,
            };
        }
    }

    return {
        available: true,
        workerOnline: typeof workerOnline === 'boolean' ? workerOnline : null,
        serverTime: new Date(now).toISOString(),
        summary,
        inFlight,
        recent,
        runs: groupRuns(recent, inFlight),
        lastCompletedAt,
    };
}
