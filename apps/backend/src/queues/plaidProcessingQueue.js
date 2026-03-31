const { Queue } = require('bullmq');
const { getRedisConnection } = require('../utils/redis');

const PLAID_PROCESSING_QUEUE_NAME = 'plaid-processing';

let plaidProcessingQueueInstance;

const getPlaidProcessingQueue = () => {
    if (!plaidProcessingQueueInstance) {
        plaidProcessingQueueInstance = new Queue(PLAID_PROCESSING_QUEUE_NAME, {
            connection: getRedisConnection(),
            defaultJobOptions: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 },
                removeOnComplete: { count: 100 },
                removeOnFail: { age: 24 * 3600 },
            },
        });
    }
    return plaidProcessingQueueInstance;
};

module.exports = {
    getPlaidProcessingQueue,
    PLAID_PROCESSING_QUEUE_NAME,
};
