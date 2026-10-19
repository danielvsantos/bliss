/**
 * Shared Twelve Data credit budget (#150).
 *
 * One sliding one-minute window, in credits, shared by every backend process
 * (`START_MODE=web` serves the ticker/pricing routes, `START_MODE=worker` runs
 * the workers) through Redis. Each call reserves its endpoint's cost
 * (`config/twelveDataCredits.js`) before the request. Twelve Data's
 * `api-credits-used` header is the running total for the key's current minute,
 * not the cost of one call, so it is logged for calibration rather than used to
 * settle reservations; usage this budget can't see (another app on the same
 * key) is handled by the 429 pause.
 *
 * Redis keys (no tenant data):
 *   td:budget:v1:log      ZSET  member `<reservationId>:<credits>`, score = grant ms
 *   td:budget:v1:waiters  ZSET  member `<priority>:<waiterId>`, score = heartbeat ms
 *   td:budget:v1:pause    STRING set with PX after a Twelve Data 429
 *
 * Priority: a blocked caller registers as a waiter and refreshes its heartbeat
 * on every attempt (at most every POLL_CAP_MS). A grant is refused while a live
 * waiter of strictly higher priority (lower number) exists. A crashed waiter
 * stops blocking after WAITER_TTL_MS.
 *
 * Safety (enforced by tests):
 *   - `acquire` never rejects. Waiting is a timer, so BullMQ lock renewal keeps
 *     running; nothing here fails a job.
 *   - A dedicated fail-fast connection (500 ms command timeout). On a Redis
 *     error the client switches to an in-process window at FALLBACK_SHARE of
 *     the limit for FALLBACK_MS, then tries Redis again.
 *   - `pause` is fire-and-forget and never throws.
 */

const crypto = require('crypto');
const Redis = require('ioredis');
const {
    getCreditsPerMinute,
    FALLBACK_SHARE,
    WINDOW_MS,
    WAITER_TTL_MS,
    POLL_CAP_MS,
    PRIORITY_NAMES,
} = require('../config/twelveDataCredits');
const logger = require('./logger');

const KEY_PREFIX = 'td:budget:v1';
const FALLBACK_MS = 30_000;
const COMMAND_TIMEOUT_MS = 500;

/**
 * KEYS: log, waiters, pause.
 * ARGV: limit, credits, priority, waiterId, reservationId, waiterTtl, window, pollCap.
 * Returns {1, 0} on a grant, {0, retryInMs} otherwise.
 */
const ACQUIRE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local limit = tonumber(ARGV[1])
local credits = tonumber(ARGV[2])
local priority = tonumber(ARGV[3])
local waiter = ARGV[3] .. ':' .. ARGV[4]
local ttl = tonumber(ARGV[6])
local window = tonumber(ARGV[7])
local pollCap = tonumber(ARGV[8])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - ttl)

local function wait(ms)
  redis.call('ZADD', KEYS[2], now, waiter)
  redis.call('PEXPIRE', KEYS[2], ttl + 10000)
  if ms < 1 then ms = 1 end
  if ms > pollCap then ms = pollCap end
  return {0, ms}
end

local paused = redis.call('PTTL', KEYS[3])
if paused > 0 then return wait(paused) end

local waiters = redis.call('ZRANGE', KEYS[2], 0, -1)
for _, w in ipairs(waiters) do
  local p = tonumber(string.match(w, '^(%d+):'))
  if p and p < priority then return wait(pollCap) end
end

local entries = redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')
local used = 0
for i = 1, #entries, 2 do
  used = used + (tonumber(string.match(entries[i], ':(%d+)$')) or 0)
end

local need = math.min(credits, limit)
if used + need <= limit then
  redis.call('ZADD', KEYS[1], now, ARGV[5] .. ':' .. need)
  redis.call('PEXPIRE', KEYS[1], window + 1000)
  redis.call('ZREM', KEYS[2], waiter)
  return {1, 0}
end

local excess = used + need - limit
local freed = 0
for i = 1, #entries, 2 do
  freed = freed + (tonumber(string.match(entries[i], ':(%d+)$')) or 0)
  if freed >= excess then
    return wait(tonumber(entries[i + 1]) + window - now)
  end
end
return wait(pollCap)
`;

/**
 * KEYS: pause. ARGV: ms. Extends, never shortens, an existing pause.
 */
const PAUSE_SCRIPT = `
local current = redis.call('PTTL', KEYS[1])
if current < tonumber(ARGV[1]) then
  redis.call('SET', KEYS[1], '1', 'PX', tonumber(ARGV[1]))
end
return 1
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const newId = () => crypto.randomBytes(8).toString('hex');

/**
 * In-process sliding window used when Redis is unreachable (fallback) or not
 * configured (local). Same priority rule as the shared path, within this
 * process only.
 */
function createLocalWindow({ windowMs, pollCapMs }) {
    let entries = []; // { at, credits }
    let pausedUntil = 0;
    const waiting = new Map(); // waiterId → priority

    const prune = (now) => {
        if (entries.length && entries[0].at <= now - windowMs) {
            entries = entries.filter((e) => e.at > now - windowMs);
        }
    };

    return {
        /** One attempt. Returns { granted: true, entry } or { granted: false, retryInMs }. */
        tryAcquire({ limit, credits, priority, waiterId }) {
            const now = Date.now();
            prune(now);
            const wait = (ms) => {
                waiting.set(waiterId, priority);
                return { granted: false, retryInMs: Math.max(1, Math.min(ms, pollCapMs)) };
            };
            if (pausedUntil > now) return wait(pausedUntil - now);
            for (const p of waiting.values()) {
                if (p < priority) return wait(pollCapMs);
            }
            const used = entries.reduce((sum, e) => sum + e.credits, 0);
            const need = Math.min(credits, limit);
            if (used + need <= limit) {
                const entry = { at: now, credits: need };
                entries.push(entry);
                waiting.delete(waiterId);
                return { granted: true, entry };
            }
            const excess = used + need - limit;
            let freed = 0;
            for (const e of entries) {
                freed += e.credits;
                if (freed >= excess) return wait(e.at + windowMs - now);
            }
            return wait(pollCapMs);
        },
        forget(waiterId) {
            waiting.delete(waiterId);
        },
        pause(ms) {
            pausedUntil = Math.max(pausedUntil, Date.now() + ms);
        },
        used() {
            prune(Date.now());
            return entries.reduce((sum, e) => sum + e.credits, 0);
        },
    };
}

/**
 * Creates a budget client. The module exports a default instance; tests build
 * their own with an injected `redis`, a short `windowMs` and a small `limit`.
 *
 * @param {Object} [options]
 * @param {Object|null|(() => Object|null)} [options.redis] ioredis client, or a getter. null = no shared store.
 * @param {number|(() => number)} [options.limit] credits per window
 * @param {number} [options.windowMs]
 * @param {number} [options.waiterTtlMs]
 * @param {number} [options.pollCapMs]
 * @param {number} [options.fallbackShare]
 * @param {string} [options.keyPrefix]
 */
function createTwelveDataBudget({
    redis = null,
    limit = getCreditsPerMinute,
    windowMs = WINDOW_MS,
    waiterTtlMs = WAITER_TTL_MS,
    pollCapMs = POLL_CAP_MS,
    fallbackShare = FALLBACK_SHARE,
    keyPrefix = KEY_PREFIX,
} = {}) {
    const keys = { log: `${keyPrefix}:log`, waiters: `${keyPrefix}:waiters`, pause: `${keyPrefix}:pause` };
    const local = createLocalWindow({ windowMs, pollCapMs });
    let fallbackUntil = 0;
    let lastWarnAt = 0;
    let announced = false;

    const getRedis = () => (typeof redis === 'function' ? redis() : redis);
    const getLimit = () => (typeof limit === 'function' ? limit() : limit);

    function ensureCommands(client) {
        if (typeof client.tdBudgetAcquire !== 'function') {
            client.defineCommand('tdBudgetAcquire', { numberOfKeys: 3, lua: ACQUIRE_SCRIPT });
            client.defineCommand('tdBudgetPause', { numberOfKeys: 1, lua: PAUSE_SCRIPT });
        }
    }

    function enterFallback(error) {
        fallbackUntil = Date.now() + FALLBACK_MS;
        const now = Date.now();
        if (now - lastWarnAt >= FALLBACK_MS) {
            lastWarnAt = now;
            logger.warn('twelve_data_budget_fallback', {
                error: error?.message,
                fallbackLimit: Math.max(1, Math.floor(getLimit() * fallbackShare)),
                retrySharedInMs: FALLBACK_MS,
            });
        }
    }

    /** Which store this attempt uses: 'shared' | 'fallback' | 'local'. */
    function currentMode(client) {
        if (!client) return 'local';
        return Date.now() < fallbackUntil ? 'fallback' : 'shared';
    }

    /**
     * Waits until `credits` fit in the window for this priority. Never rejects.
     * @returns {Promise<{ reservationId: string, credits: number, waitedMs: number, mode: string }>}
     */
    async function acquire({ endpoint, credits, priority }) {
        const start = Date.now();
        const waiterId = newId();
        const reservationId = newId();
        const fullLimit = getLimit();
        if (!announced) {
            announced = true;
            logger.info('twelve_data_budget_ready', { creditsPerMinute: fullLimit, shared: Boolean(getRedis()) });
        }

        for (;;) {
            let retryInMs = pollCapMs;
            const client = getRedis();
            const mode = currentMode(client);
            try {
                if (mode === 'shared') {
                    ensureCommands(client);
                    const res = await client.tdBudgetAcquire(
                        keys.log, keys.waiters, keys.pause,
                        String(fullLimit), String(credits), String(priority), waiterId, reservationId,
                        String(waiterTtlMs), String(windowMs), String(pollCapMs),
                    );
                    if (Number(res[0]) === 1) {
                        local.forget(waiterId);
                        return { reservationId, credits: Math.min(credits, fullLimit), waitedMs: Date.now() - start, mode, endpoint };
                    }
                    retryInMs = Number(res[1]) || pollCapMs;
                } else {
                    const localLimit = mode === 'local'
                        ? fullLimit
                        : Math.max(1, Math.floor(fullLimit * fallbackShare));
                    const res = local.tryAcquire({ limit: localLimit, credits, priority, waiterId });
                    if (res.granted) {
                        return { reservationId, credits: res.entry.credits, waitedMs: Date.now() - start, mode, endpoint };
                    }
                    retryInMs = res.retryInMs;
                }
            } catch (error) {
                enterFallback(error);
                retryInMs = 0;
            }
            if (retryInMs > 0) {
                logger.debug('twelve_data_budget_wait', {
                    endpoint, credits, priority: PRIORITY_NAMES[priority] || priority, mode, retryInMs,
                });
                await sleep(retryInMs);
            }
        }
    }

    /** Pauses every caller (all processes) for `ms` after a Twelve Data 429. Never throws. */
    function pause(ms) {
        try {
            if (!Number.isFinite(ms) || ms <= 0) return;
            local.pause(ms);
            const client = getRedis();
            if (!client || Date.now() < fallbackUntil) return;
            ensureCommands(client);
            const pending = client.tdBudgetPause(keys.pause, String(Math.ceil(ms)));
            if (pending && typeof pending.catch === 'function') pending.catch(() => {});
        } catch {
            // pausing is best effort; the local pause still applies
        }
    }

    return { acquire, pause, keys, localUsed: () => local.used() };
}

// ── Default instance ─────────────────────────────────────────────────────────

let client = null;
let clientOverride;

function isSharedEnabled() {
    if (clientOverride !== undefined) return clientOverride !== null;
    if (process.env.NODE_ENV === 'test') return false;
    return Boolean(process.env.REDIS_URL);
}

function getClient() {
    if (clientOverride !== undefined) return clientOverride;
    if (!isSharedEnabled()) return null;
    if (!client) {
        client = new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: 1,
            commandTimeout: COMMAND_TIMEOUT_MS,
            enableReadyCheck: false,
            keepAlive: 10000,
            connectionName: 'bliss-twelve-data-budget',
            retryStrategy: (times) => Math.min(times * 500, 10_000),
        });
        client.on('error', () => {
            // surfaced through the fallback warning on the next acquire
        });
    }
    return client;
}

let defaultBudget = createTwelveDataBudget({ redis: getClient });

/** Unit tests (NODE_ENV=test) skip the budget unless a client is injected. */
function isBypassed() {
    return process.env.NODE_ENV === 'test' && clientOverride === undefined;
}

async function acquire(request) {
    if (isBypassed()) {
        return { reservationId: 'test', credits: request.credits, waitedMs: 0, mode: 'disabled', endpoint: request.endpoint };
    }
    return defaultBudget.acquire(request);
}

function pause(ms) {
    if (isBypassed()) return;
    defaultBudget.pause(ms);
}

async function closeTwelveDataBudget() {
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

/**
 * Tests only: route the default instance to `redis` (null = no shared store,
 * in-process only; undefined = reset to the test bypass) with optional options.
 */
function __setClientForTests(redis, options = {}) {
    clientOverride = redis;
    defaultBudget = createTwelveDataBudget({ redis: getClient, ...options });
}

module.exports = {
    acquire,
    pause,
    closeTwelveDataBudget,
    createTwelveDataBudget,
    __setClientForTests,
};
