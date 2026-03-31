const express = require('express');
const router = express.Router();
const apiKeyAuth = require('../middleware/apiKeyAuth');
const { enqueueInsightJob } = require('../queues/insightQueue');
const logger = require('../utils/logger');

/**
 * POST /api/insights/generate
 *
 * Internal endpoint to trigger insight generation for a tenant.
 * Body: { tenantId: string }
 *
 * Returns 202 (accepted) immediately; generation happens async in worker.
 */
router.post('/generate', apiKeyAuth, async (req, res) => {
    try {
        const { tenantId } = req.body;
        if (!tenantId) {
            return res.status(400).json({ error: 'tenantId is required' });
        }

        await enqueueInsightJob('generate-tenant-insights', { tenantId });

        logger.info('Insight generation job enqueued:', { tenantId });
        return res.status(202).json({ message: 'Insight generation job enqueued' });
    } catch (error) {
        logger.error('Error enqueuing insight job:', { error: error.message });
        return res.status(500).json({ error: 'Failed to enqueue insight job' });
    }
});

module.exports = router;
