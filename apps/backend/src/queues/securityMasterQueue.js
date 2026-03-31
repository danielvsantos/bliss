const { Queue } = require('bullmq');
const { getRedisConnection } = require('../utils/redis');
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

        securityMasterQueueInstance.on('error', (error) => {
            logger.error('SecurityMaster queue error:', { error: error.message });
        });
    }
    return securityMasterQueueInstance;
};

async function enqueueSecurityMasterJob(jobName, data) {
    return getSecurityMasterQueue().add(jobName, data);
}

module.exports = {
    getSecurityMasterQueue,
    SECURITY_MASTER_QUEUE_NAME,
    enqueueSecurityMasterJob,
};
