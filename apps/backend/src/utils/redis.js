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
            // Reconnect with exponential backoff (max 10s) if connection drops
            retryStrategy(times) {
                const delay = Math.min(times * 200, 10000);
                logger.warn(`Redis reconnecting, attempt ${times} (delay ${delay}ms)`);
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