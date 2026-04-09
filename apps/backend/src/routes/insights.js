const express = require('express');
const router = express.Router();
const apiKeyAuth = require('../middleware/apiKeyAuth');
const { enqueueInsightJob } = require('../queues/insightQueue');
const { cleanupExpiredInsights } = require('../services/insightRetentionService');
const { VALID_TIERS } = require('../services/insightService');
const logger = require('../utils/logger');

/**
 * POST /api/insights/generate
 *
 * Internal endpoint to trigger insight generation for a tenant.
 * Body: {
 *   tenantId: string (required),
 *   tier:     string (required — MONTHLY | QUARTERLY | ANNUAL | PORTFOLIO),
 *   year:     number (required for MONTHLY / QUARTERLY / ANNUAL),
 *   month:    number (required for MONTHLY),
 *   quarter:  number (required for QUARTERLY),
 *   periodKey: string (optional — auto-computed if not provided),
 *   force:    boolean (optional — bypass completeness check)
 * }
 *
 * Returns 202 (accepted) immediately; generation happens async in worker.
 */
router.post('/generate', apiKeyAuth, async (req, res) => {
  try {
    const { tenantId, tier, year, month, quarter, periodKey, force } = req.body;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    if (!tier) {
      return res.status(400).json({
        error: `tier is required. Must be one of: ${VALID_TIERS.join(', ')}`,
      });
    }
    if (!VALID_TIERS.includes(tier)) {
      return res.status(400).json({
        error: `Invalid tier: ${tier}. Must be one of: ${VALID_TIERS.join(', ')}`,
      });
    }

    // Validate required params per tier
    if (tier === 'MONTHLY' && (!year || !month)) {
      return res.status(400).json({ error: 'year and month are required for MONTHLY tier' });
    }
    if (tier === 'QUARTERLY' && (!year || !quarter)) {
      return res.status(400).json({ error: 'year and quarter are required for QUARTERLY tier' });
    }
    if (tier === 'ANNUAL' && !year) {
      return res.status(400).json({ error: 'year is required for ANNUAL tier' });
    }

    await enqueueInsightJob('generate-tenant-insights', {
      tenantId, tier, year, month, quarter, periodKey, force,
    });

    logger.info('Insight generation job enqueued:', { tenantId, tier });
    return res.status(202).json({
      message: 'Insight generation job enqueued',
      tier,
    });
  } catch (error) {
    logger.error('Error enqueuing insight job:', { error: error.message });
    return res.status(500).json({ error: 'Failed to enqueue insight job' });
  }
});

/**
 * POST /api/insights/cleanup
 *
 * Internal endpoint to trigger TTL cleanup of expired insights.
 * No body required.
 */
router.post('/cleanup', apiKeyAuth, async (req, res) => {
  try {
    const deletedCount = await cleanupExpiredInsights();
    return res.status(200).json({ deletedCount });
  } catch (error) {
    logger.error('Error cleaning up insights:', { error: error.message });
    return res.status(500).json({ error: 'Failed to cleanup insights' });
  }
});

module.exports = router;
