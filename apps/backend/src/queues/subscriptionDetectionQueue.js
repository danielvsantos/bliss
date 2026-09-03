const { Queue } = require('bullmq');
const { getRedisConnection } = require('../utils/redis');
const logger = require('../utils/logger');

const SUBSCRIPTION_DETECTION_QUEUE_NAME = 'subscription-detection';

let subscriptionDetectionQueueInstance;

const getSubscriptionDetectionQueue = () => {
    if (!subscriptionDetectionQueueInstance) {
        subscriptionDetectionQueueInstance = new Queue(SUBSCRIPTION_DETECTION_QUEUE_NAME, {
            connection: getRedisConnection(),
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 1000,
                },
                removeOnComplete: {
                    age: 24 * 3600,
                    count: 1000,
                },
                removeOnFail: {
                    age: 7 * 24 * 3600,
                },
            },
        });

        subscriptionDetectionQueueInstance.on('error', (error) => {
            logger.error('Subscription detection queue error:', { error: error.message });
        });

        subscriptionDetectionQueueInstance.on('failed', (job, error) => {
            logger.error('Subscription detection job failed:', { jobId: job?.id, name: job?.name, error: error.message });
        });

        subscriptionDetectionQueueInstance.on('completed', (job) => {
            logger.info('Subscription detection job completed successfully:', { jobId: job.id, name: job.name });
        });
    }
    return subscriptionDetectionQueueInstance;
};

async function enqueueSubscriptionDetectionJob(jobName, data, opts = {}) {
    return getSubscriptionDetectionQueue().add(jobName, data, opts);
}

module.exports = {
    getSubscriptionDetectionQueue,
    SUBSCRIPTION_DETECTION_QUEUE_NAME,
    enqueueSubscriptionDetectionJob,
};
