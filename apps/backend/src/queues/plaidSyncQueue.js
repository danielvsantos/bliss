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

// Enable Banking (#132): one pending sync per connection. While a sync for this
// item is waiting, delayed, active or retrying, further adds are dropped (a
// scheduled slot and a "Sync now" collapse into one access). 5xx / network
// failures retry with a 30 s exponential backoff.
const enableBankingSyncOpts = (plaidItemId) => ({
    deduplication: { id: `eb-sync:${plaidItemId}` },
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
});

module.exports = {
    getPlaidSyncQueue,
    enableBankingSyncOpts,
    PLAID_SYNC_QUEUE_NAME,
};
