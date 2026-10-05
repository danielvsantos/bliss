const { Queue } = require('bullmq');
const { getRedisConnection } = require('../utils/redis');
const { trackQueue } = require('../utils/activityTracker');

const PLAID_SYNC_QUEUE_NAME = 'plaid-sync';

let plaidSyncQueueInstance;

const getPlaidSyncQueue = () => {
    if (!plaidSyncQueueInstance) {
        plaidSyncQueueInstance = new Queue(PLAID_SYNC_QUEUE_NAME, {
            connection: getRedisConnection(),
            defaultJobOptions: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 },
                removeOnComplete: { count: 100 },
                removeOnFail: { age: 24 * 3600 },
            },
        });
        // Processing status (#100): a `queued` entry for every tenant job added.
        trackQueue(plaidSyncQueueInstance);
    }
    return plaidSyncQueueInstance;
};

module.exports = {
    getPlaidSyncQueue,
    PLAID_SYNC_QUEUE_NAME,
};
