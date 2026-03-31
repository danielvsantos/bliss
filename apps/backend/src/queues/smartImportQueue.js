const { Queue } = require('bullmq');
const { getRedisConnection } = require('../utils/redis');
const logger = require('../utils/logger');

const SMART_IMPORT_QUEUE_NAME = 'smart-import';

let smartImportQueue;

/**
 * Initializes and returns the singleton instance of the smart import BullMQ queue.
 * Used for the AI-powered CSV import pipeline (adapter detection → classification → staging).
 *
 * @returns {import('bullmq').Queue} The smart import queue instance.
 */
const getSmartImportQueue = () => {
  if (!smartImportQueue) {
    const redisConnection = getRedisConnection();
    if (!redisConnection) {
      throw new Error(
        'Redis connection not initialized for Smart Import Queue. Call initializeRedis first.'
      );
    }
    smartImportQueue = new Queue(SMART_IMPORT_QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { age: 24 * 3600 },
      },
    });

    smartImportQueue.on('error', (err) => {
      logger.error(`Smart Import Queue Error: ${err.message}`, {
        stack: err.stack,
      });
    });
  }
  return smartImportQueue;
};

module.exports = {
  getSmartImportQueue,
  SMART_IMPORT_QUEUE_NAME,
};
