const { Queue } = require('bullmq');
const { getRedisConnection } = require('../utils/redis');
const { trackQueue } = require('../utils/activityTracker');
const logger = require('../utils/logger');

const SECURITY_MASTER_QUEUE_NAME = 'security-master';

let securityMasterQueueInstance;

const getSecurityMasterQueue = () => {
    if (!securityMasterQueueInstance) {
        securityMasterQueueInstance = new Queue(SECURITY_MASTER_QUEUE_NAME, {
            connection: getRedisConnection(),
            defaultJobOptions: {
                attempts: 2,
                backoff: {
                    type: 'exponential',
                    delay: 5000,
                },
                removeOnComplete: {
                    age: 24 * 3600,
                    count: 500,
                },
                removeOnFail: {
                    age: 7 * 24 * 3600,
                },
            },
        });
        // Processing status (#100): a `queued` entry for every tenant job added.
        trackQueue(securityMasterQueueInstance);

        securityMasterQueueInstance.on('error', (error) => {
            logger.error('SecurityMaster queue error:', { error: error.message });
        });
    }
    return securityMasterQueueInstance;
};

async function enqueueSecurityMasterJob(jobName, data) {
    return getSecurityMasterQueue().add(jobName, data);
}

// BullMQ simple-mode deduplication for the tenant-scoped refresh (#77): while a
// `refresh-tenant-securities` job for this tenant is waiting, delayed, active
// or retrying, further adds are dropped. Not a fixed `jobId` — completed jobs
// are kept for 24h and would block every refresh for a day. Same pattern as
// `fullValuationDedupOpts()` in portfolioQueue.js.
const tenantSecuritiesDedupOpts = (tenantId) => ({
    deduplication: { id: `tenant-securities-${tenantId}` },
});

/**
 * Enqueue `refresh-tenant-securities` for a tenant (deduplicated per tenant).
 * @param {string} tenantId
 * @param {{ force?: boolean, _rebuildMeta?: Object }} [data]
 * @param {Object} [opts] extra BullMQ job options (e.g. manual-rebuild retention)
 */
async function enqueueTenantSecuritiesRefresh(tenantId, data = {}, opts = {}) {
    return getSecurityMasterQueue().add(
        'refresh-tenant-securities',
        { tenantId, force: false, ...data },
        { ...tenantSecuritiesDedupOpts(tenantId), ...opts },
    );
}

module.exports = {
    getSecurityMasterQueue,
    SECURITY_MASTER_QUEUE_NAME,
    enqueueSecurityMasterJob,
    enqueueTenantSecuritiesRefresh,
    tenantSecuritiesDedupOpts,
};
