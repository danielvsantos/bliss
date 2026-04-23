// ── ioredis warning suppression ────────────────────────────────────────────
//
// ioredis emits two hardcoded `console.warn` messages when the Redis server
// says the `default` user doesn't require a password but the client sent
// one anyway:
//
//   [WARN] Redis server does not require a password, but a password was supplied.
//   [WARN] This Redis server's `default` user does not require a password, but a password was supplied
//
// This is benign — the client's AUTH was ignored and the connection
// proceeded normally. In local development it fires once per ioredis
// client (and BullMQ creates multiple per queue for cmd + pubsub), so
// it spams the console on every worker boot.
//
// The cleanest fix in userland is to strip the password from REDIS_URL
// when the server doesn't require it, but that breaks for anyone whose
// local Redis *does* require a password. Suppressing these two exact
// strings keeps the noise out while leaving every other console.warn
// (including our own logger, which doesn't use console.warn directly)
// untouched.
//
// Must run BEFORE `require('ioredis')` so the patched console is
// captured by ioredis's module-level bindings.
(() => {
    const IOREDIS_BENIGN_WARNINGS = [
        'Redis server does not require a password, but a password was supplied',
        "This Redis server's `default` user does not require a password",
    ];
    const origWarn = console.warn;
    console.warn = (...args) => {
        const first = args[0];
        if (typeof first === 'string' && IOREDIS_BENIGN_WARNINGS.some((s) => first.includes(s))) {
            return; // swallow benign ioredis noise
        }
        return origWarn.apply(console, args);
    };
})();

const Redis = require('ioredis');
const logger = require('./logger');
// dotenv loaded in src/index.js — no need to load again here

let redisConnection;
let pingInterval;

const PING_INTERVAL_MS = 30_000; // Send PING every 30s to prevent idle timeout

const initializeRedis = () => {
    return new Promise((resolve, reject) => {
        const redisUrl = process.env.REDIS_URL;
        if (!redisUrl) {
            logger.error('REDIS_URL is not defined in environment variables.');
            return reject(new Error('REDIS_URL is not defined.'));
        }

        const newConnection = new Redis(redisUrl, {
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            // Keep TCP socket alive during long-running Prisma transactions
            // so cloud Redis providers don't reset idle connections.
            keepAlive: 10000,
            // Reconnect with exponential backoff (max 10s) if connection drops.
            //
            // Logging cadence: Redis drops idle connections on a routine basis
            // (cloud providers, local `redis.conf timeout`), and BullMQ keeps
            // up to 2-3 sockets per queue alive, so benign reconnects fire in
            // bursts of 7+ at a time. Logging every attempt at `warn` buries
            // everything else. We only surface at `warn` once the reconnect
            // loop has actually struggled (attempt 3+); earlier attempts go
            // to `debug` so you can still see them via LOG_LEVEL=debug if
            // you're investigating.
            retryStrategy(times) {
                const delay = Math.min(times * 200, 10000);
                const msg = `Redis reconnecting, attempt ${times} (delay ${delay}ms)`;
                if (times >= 3) logger.warn(msg);
                else logger.debug(msg);
                return delay;
            },
        });

        newConnection.on('connect', () => {
            logger.info('Successfully connected to Redis.');
            redisConnection = newConnection;

            // Application-level keepalive: periodic PING prevents Redis server
            // from closing idle connections (its `timeout` config). TCP keepalive
            // alone is insufficient because Redis tracks idleness at the command level.
            if (pingInterval) clearInterval(pingInterval);
            pingInterval = setInterval(() => {
                if (redisConnection && redisConnection.status === 'ready') {
                    redisConnection.ping().catch(() => {});
                }
            }, PING_INTERVAL_MS);
            pingInterval.unref(); // Don't prevent process exit

            // Check Redis server timeout config and warn if non-zero
            newConnection.config('GET', 'timeout').then((result) => {
                const timeout = result && result[1];
                if (timeout && parseInt(timeout, 10) > 0) {
                    logger.warn(`Redis server has timeout=${timeout}s. Consider setting to 0 to prevent idle disconnects.`);
                }
            }).catch(() => {}); // Ignore if CONFIG is disabled (e.g. managed Redis)

            resolve(redisConnection);
        });

        newConnection.on('error', (err) => {
            logger.error('Redis connection error:', err);
            reject(err);
        });
    });
};

const disconnectRedis = async () => {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
    if (redisConnection) {
        await redisConnection.quit();
        logger.info('Redis connection closed.');
    }
};

module.exports = {
    initializeRedis,
    disconnectRedis,
    getRedisConnection: () => {
        if (!redisConnection) {
            throw new Error('Redis has not been initialized. Please call initializeRedis first.');
        }
        return redisConnection;
    },
}; 