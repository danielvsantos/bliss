const { getRedisConnection } = require('../utils/redis');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

/**
 * Schedules a debounced job using Redis to aggregate data from high-frequency events.
 *
 * @param {import('bullmq').Queue} queue - The BullMQ queue instance.
 * @param {string} jobName - The name of the job to schedule.
 * @param {object} jobData - The data for the job, including tenantId and the data to be aggregated.
 * @param {string} aggregationKey - The key within jobData (e.g., 'scopes', 'portfolioItemIds') that holds the array to be aggregated.
 * @param {number} delayInSeconds - The debounce delay in seconds.
 */
async function scheduleDebouncedJob(queue, jobName, jobData, aggregationKey, delayInSeconds) {
    const redis = getRedisConnection();
    const tenantId = jobData.tenantId;
    if (!tenantId) {
        logger.warn(`Debounce service called for job ${jobName} without a tenantId. Skipping.`);
        return;
    }

    const redisKey = `debounce:${jobName}:tenant:${tenantId}`;

    try {
        // Fetch the existing debounced job details from Redis.
        const existingJobString = await redis.get(redisKey);
        let existingJob = null;
        if (existingJobString) {
            try {
                existingJob = JSON.parse(existingJobString);
            } catch (e) {
                logger.error(`Failed to parse existing debounced job from Redis for key ${redisKey}.`, { error: e.message, value: existingJobString });
            }
        }

        // If a job is already scheduled, remove it. We will replace it with a new one.
        if (existingJob && existingJob.jobId) {
            const job = await queue.getJob(existingJob.jobId);
            if (job) {
                try {
                    await job.remove();
                    logger.info(`[Debounce] Canceled pending job ${existingJob.jobId} for ${jobName} to extend scope.`);
                } catch (e) {
                    logger.warn(`[Debounce] Could not remove job ${existingJob.jobId}, it may have already run.`, { error: e.message });
                }
            }
        }

        // Aggregate the new data with any existing data.
        const newAggregationData = jobData[aggregationKey] || [];
        const existingAggregationData = (existingJob && existingJob[aggregationKey]) || [];
        
        // Use a Set to ensure all items in the aggregation array are unique.
        // For objects, we stringify them to ensure uniqueness based on content.
        const combinedData = [...existingAggregationData, ...newAggregationData];
        const uniqueData = Array.from(new Set(combinedData.map(item => typeof item === 'object' ? JSON.stringify(item) : item)))
                                .map(item => typeof item === 'string' && item.startsWith('{') ? JSON.parse(item) : item);

        const aggregatedJobData = {
            ...jobData,
            [aggregationKey]: uniqueData,
        };

        // Schedule the new job with the aggregated data.
        const newJob = await queue.add(jobName, aggregatedJobData, {
            delay: delayInSeconds * 1000,
            jobId: uuidv4() // Assign a unique ID to make it easier to track/cancel
        });

        // Store the new job's details back in Redis with an expiry.
        const newJobDetails = {
            jobId: newJob.id,
            ...aggregatedJobData
        };
        await redis.set(redisKey, JSON.stringify(newJobDetails), 'EX', delayInSeconds + 5); // 5-seconds buffer

        logger.info(`[Debounce] Scheduled new job ${newJob.id} for ${jobName} with aggregated scope.`, { tenantId, newScope: aggregatedJobData[aggregationKey] });

    } catch (error) {
        logger.error(`[Debounce] Error in scheduleDebouncedJob for ${jobName}.`, {
            tenantId,
            error: error.message,
            stack: error.stack,
        });
    }
}

module.exports = { scheduleDebouncedJob }; 