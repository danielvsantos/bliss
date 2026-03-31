const { Queue } = require('bullmq');
const { getRedisConnection } = require('../utils/redis');
const logger = require('../utils/logger');

const PORTFOLIO_QUEUE_NAME = 'portfolio';

let portfolioQueueInstance;

const getPortfolioQueue = () => {
    if (!portfolioQueueInstance) {
        portfolioQueueInstance = new Queue(PORTFOLIO_QUEUE_NAME, {
            connection: getRedisConnection(),
            defaultJobOptions: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 },
                removeOnComplete: { age: 24 * 3600, count: 1000 },
                removeOnFail: { age: 7 * 24 * 3600 },
            },
        });

        portfolioQueueInstance.on('error', (error) => {
            logger.error(`Portfolio queue error:`, { error: error.message });
        });

        portfolioQueueInstance.on('failed', (job, error) => {
            logger.error(`Portfolio job failed:`, { jobId: job.id, name: job.name, error: error.message });
        });
    }
    return portfolioQueueInstance;
};

async function enqueuePortfolioJob(jobName, data) {
    try {
        await getPortfolioQueue().add(jobName, data);
        logger.info(`Successfully enqueued portfolio job: ${jobName}`);
    } catch (error) {
        logger.error(`Failed to enqueue portfolio job: ${jobName}`, { error });
        throw error;
    }
}

module.exports = {
    getPortfolioQueue,
    enqueuePortfolioJob,
    PORTFOLIO_QUEUE_NAME,
}; 