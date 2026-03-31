const { Queue } = require('bullmq');
const { getRedisConnection } = require('../utils/redis');
const logger = require('../utils/logger');

const ANALYTICS_QUEUE_NAME = 'analytics';

let analyticsQueueInstance;

const getAnalyticsQueue = () => {
    if (!analyticsQueueInstance) {
        analyticsQueueInstance = new Queue(ANALYTICS_QUEUE_NAME, {
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

        // Attach event listeners only once, right after creation
        analyticsQueueInstance.on('error', (error) => {
            logger.error('Analytics queue error:', { error: error.message });
        });

        analyticsQueueInstance.on('failed', (job, error) => {
            logger.error('Analytics job failed:', { jobId: job.id, name: job.name, error: error.message });
        });

        analyticsQueueInstance.on('completed', (job) => {
            logger.info('Analytics job completed successfully:', { jobId: job.id, name: job.name });
        });
    }
    return analyticsQueueInstance;
};


async function getQueueMetrics() {
    if (!analyticsQueueInstance) {
        return { waiting: 0, active: 0, completed: 0, failed: 0 };
    }
    const [waiting, active, completed, failed] = await Promise.all([
        analyticsQueueInstance.getWaitingCount(),
        analyticsQueueInstance.getActiveCount(),
        analyticsQueueInstance.getCompletedCount(),
        analyticsQueueInstance.getFailedCount()
    ]);

    return { waiting, active, completed, failed };
}

async function enqueueAnalyticsJob(jobName, data) {
    return getAnalyticsQueue().add(jobName, data);
}

module.exports = {
    getAnalyticsQueue,
    ANALYTICS_QUEUE_NAME,
    getQueueMetrics,
    enqueueAnalyticsJob
}; 