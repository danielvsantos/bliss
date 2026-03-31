const { Queue } = require('bullmq');
const { getRedisConnection } = require('../utils/redis');

const EVENTS_QUEUE_NAME = 'events';

let eventsQueueInstance;

const getEventsQueue = () => {
  if (!eventsQueueInstance) {
    eventsQueueInstance = new Queue(EVENTS_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }
  return eventsQueueInstance;
};

const enqueueEvent = async (jobName, data) => {
  await getEventsQueue().add(jobName, data);
};

module.exports = {
  getEventsQueue,
  enqueueEvent,
  EVENTS_QUEUE_NAME,
}; 