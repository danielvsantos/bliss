const { Queue } = require('bullmq');
const { getRedisConnection } = require('../utils/redis');
const logger = require('../utils/logger');

const INSIGHT_QUEUE_NAME = 'insights';

let insightQueueInstance;

const getInsightQueue = () => {
    if (!insightQueueInstance) {
        insightQueueInstance = new Queue(INSIGHT_QUEUE_NAME, {
            connection: getRedisConnection(),
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 2000,
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

        insightQueueInstance.on('error', (error) => {
            logger.error('Insight queue error:', { error: error.message });
        });
    }
    return insightQueueInstance;
};

async function enqueueInsightJob(jobName, data) {
    return getInsightQueue().add(jobName, data);
}

module.exports = {
    getInsightQueue,
    INSIGHT_QUEUE_NAME,
    enqueueInsightJob,
};
