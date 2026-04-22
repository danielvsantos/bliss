const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const app = require('./app');
const { startPortfolioWorker } = require('./workers/portfolioWorker');
const { startEventSchedulerWorker } = require('./workers/eventSchedulerWorker');
const { startAnalyticsWorker } = require('./workers/analyticsWorker');
const { startPlaidSyncWorker } = require('./workers/plaidSyncWorker');
const { startPlaidProcessorWorker } = require('./workers/plaidProcessorWorker');
const { startSmartImportWorker } = require('./workers/smartImportWorker');
const { startInsightGeneratorWorker } = require('./workers/insightGeneratorWorker');
const { startSecurityMasterWorker } = require('./workers/securityMasterWorker');
const { initializeRedis, disconnectRedis } = require('./utils/redis');
const logger = require('./utils/logger');
const { waitForSchemaAndRefresh } = require('./utils/categoryCache');
const { validateEnv } = require('./utils/validateEnv');

const PORT = process.env.PORT || 3001;

// Track worker references for ordered shutdown (workers closed before Redis)
const workers = [];

const startServer = async () => {
    try {
        const startMode = process.env.START_MODE || 'all';
        logger.info(`Starting Bliss Backend Service in mode: ${startMode}`);

        // Guard: require TLS-encrypted Redis in production.
        // Set REDIS_SKIP_TLS_CHECK=true when using a provider whose private/internal network
        // does not expose a rediss:// endpoint (e.g. Railway private-network Redis).
        const redisUrl = process.env.REDIS_URL || '';
        const skipTlsCheck = process.env.REDIS_SKIP_TLS_CHECK === 'true';
        if (process.env.NODE_ENV === 'production' && redisUrl &&
            !redisUrl.startsWith('rediss://') && !skipTlsCheck) {
            throw new Error('REDIS_URL must use the rediss:// scheme (TLS) in production. Current value uses an unencrypted connection.');
        }

        // 0. Validate environment variables
        validateEnv();

        // 1. Initialize Redis Connection (Needed by both)
        await initializeRedis();
        logger.info('Redis initialized successfully.');

        // 2. Start Workers if mode is 'worker' or 'all'
        if (startMode === 'worker' || startMode === 'all') {
            logger.info('Starting all workers...');
            workers.push(startPortfolioWorker());
            workers.push(startEventSchedulerWorker());
            workers.push(startAnalyticsWorker());
            workers.push(startPlaidSyncWorker());
            workers.push(startPlaidProcessorWorker());
            workers.push(startSmartImportWorker());
            workers.push(startInsightGeneratorWorker());
            workers.push(startSecurityMasterWorker());
            logger.info('All workers have been started.');
        } else {
            logger.info('Skipping worker initialization (START_MODE is not "worker" or "all").');
        }

        // 3. Start Express Server if mode is 'web' or 'all'
        if (startMode === 'web' || startMode === 'all') {
            // Initial data cache refresh. In Docker Compose the api container
            // runs `prisma migrate deploy` in parallel with backend startup, so
            // the Category table may not exist yet — retry quietly until it does.
            await waitForSchemaAndRefresh();

            app.listen(PORT, () => {
                logger.info(`Bliss Backend Service listening on port ${PORT}`);
            });
        } else {
            logger.info('Skipping Express server initialization (START_MODE is not "web" or "all").');
        }

    } catch (error) {
        logger.error('Failed to start the backend service:', error);
        process.exit(1);
    }
};

startServer();

const gracefulShutdown = async () => {
    logger.info('Shutting down Bliss Backend Service...');
    // 1. Close all workers first (they need Redis to clean up)
    try {
        logger.info(`Closing ${workers.length} workers...`);
        await Promise.allSettled(workers.map((w) => w.close()));
        logger.info('All workers closed.');
    } catch (err) {
        logger.warn('Error closing workers during shutdown:', err.message);
    }
    // 2. Now safe to disconnect Redis
    try {
        await disconnectRedis();
    } catch (err) {
        logger.warn('Error disconnecting Redis during shutdown:', err.message);
    }
    process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Catch stray socket/connection errors (e.g. Redis ECONNRESET during idle)
// so they don't crash the process or go unnoticed.
process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection:', reason);
});
