const express = require('express');
const router = express.Router();
const { enqueueEvent } = require('../queues/eventsQueue');
const logger = require('../utils/logger');
const apiKeyAuth = require('../middleware/apiKeyAuth');

// This endpoint receives events from other services (e.g., the finance API)
// and enqueues them for processing by the eventSchedulerWorker.
router.post('/', apiKeyAuth, async (req, res) => {
    const { type, ...data } = req.body;

    if (!type) {
        return res.status(400).json({ error: 'Event type is required' });
    }

    try {
        await enqueueEvent(type, data);
        logger.info(`Event enqueued successfully: ${type}`, { data });
        res.status(202).json({ message: 'Event accepted' });
    } catch (error) {
        logger.error(`Failed to enqueue event: ${type}`, { error: error.message });
        res.status(500).json({ error: 'Failed to enqueue event' });
    }
});

module.exports = router; 