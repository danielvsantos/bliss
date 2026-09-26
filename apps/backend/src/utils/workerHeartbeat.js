const { getRedisConnection } = require('./redis');
const { getRuntimeInfo } = require('./runtimeInfo');
const logger = require('./logger');

/**
 * Worker runtime heartbeat.
 *
 * On Railway the backend is deployed twice — one service with START_MODE=web,
 * one with START_MODE=worker. The worker never calls `app.listen()`
 * (see index.js), so it has **no HTTP server at all**: it cannot be polled,
 * proxied to, or health-checked over the network. Without this, the only way to
 * learn what the worker is running is a shell into the container.
 *
 * So the worker publishes its own runtime to Redis, which both services already
 * share, and the web instance serves it alongside its own on /api/runtime.
 *
 * The TTL is the point, not an afterthought. A key that is present means the
 * worker wrote it within the last interval; a key that is missing or stale
 * means the worker is dead or wedged — which is operational information Bliss
 * currently has no way to surface at all. Hence a repeating heartbeat rather
 * than a single write at boot, which would leave a dead worker looking healthy
 * forever.
 */

const HEARTBEAT_KEY = 'bliss:runtime:worker';

/** How often the worker refreshes the key. */
const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Key lifetime. Deliberately longer than the interval so one slow or skipped
 * beat (a GC pause, a busy event loop during a large import) does not make a
 * healthy worker look dead. Short enough that a genuinely dead worker is
 * obvious within a few minutes.
 */
const HEARTBEAT_TTL_SECONDS = 180;

let timer = null;

async function writeHeartbeat() {
  const payload = {
    ...getRuntimeInfo('backend-worker'),
    heartbeatAt: new Date().toISOString(),
  };

  const redis = getRedisConnection();
  await redis.set(HEARTBEAT_KEY, JSON.stringify(payload), 'EX', HEARTBEAT_TTL_SECONDS);
}

/**
 * Begin publishing. Called from index.js only when workers start.
 *
 * Failures are logged and swallowed: a diagnostic that can take the worker
 * process down is worse than no diagnostic. The missing key is itself the
 * signal.
 */
function startWorkerHeartbeat() {
  if (timer) return timer;

  const beat = () => {
    writeHeartbeat().catch((error) => {
      logger.warn('[runtime] worker heartbeat write failed', { error: error.message });
    });
  };

  beat();

  timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  // Do not hold the event loop open on shutdown.
  if (typeof timer.unref === 'function') timer.unref();

  logger.info('[runtime] worker heartbeat started', {
    intervalMs: HEARTBEAT_INTERVAL_MS,
    ttlSeconds: HEARTBEAT_TTL_SECONDS,
  });

  return timer;
}

function stopWorkerHeartbeat() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Read the worker's published runtime.
 *
 * @returns {Promise<object>} the payload, or a `status` describing why it is
 *   absent. Never throws — an unreachable Redis must not fail the whole
 *   /api/runtime response, since the rest of it is still useful.
 */
async function readWorkerHeartbeat() {
  try {
    const raw = await getRedisConnection().get(HEARTBEAT_KEY);
    if (!raw) {
      return {
        status: 'absent',
        note:
          'No heartbeat in Redis. The worker service is down, wedged, or has not ' +
          'been deployed with START_MODE=worker.',
      };
    }
    return { status: 'alive', ...JSON.parse(raw) };
  } catch (error) {
    return { status: 'unavailable', note: `Could not read heartbeat: ${error.message}` };
  }
}

module.exports = {
  startWorkerHeartbeat,
  stopWorkerHeartbeat,
  readWorkerHeartbeat,
  HEARTBEAT_KEY,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TTL_SECONDS,
};
