const express = require('express');
const router = express.Router();
const apiKeyAuth = require('../middleware/apiKeyAuth');
const securityMasterService = require('../services/securityMasterService');
const { enqueueSecurityMasterJob } = require('../queues/securityMasterQueue');
const logger = require('../utils/logger');

/**
 * GET /api/security-master
 *
 * Internal endpoint: fetches a single SecurityMaster record by symbol.
 *
 * Query params:
 *   ?symbol=<string>  — Ticker symbol (required)
 *
 * Returns: SecurityMaster record or 404
 */
router.get('/', apiKeyAuth, async (req, res) => {
    const { symbol } = req.query;

    if (!symbol || typeof symbol !== 'string' || !symbol.trim()) {
        return res.status(400).json({ error: 'symbol query parameter is required' });
    }

    try {
        const record = await securityMasterService.getBySymbol(symbol.trim());

        if (!record) {
            return res.status(404).json({ error: `No SecurityMaster record for symbol: ${symbol}` });
        }

        res.status(200).json(record);
    } catch (error) {
        logger.error(`SecurityMaster lookup failed for "${symbol}": ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch SecurityMaster record' });
    }
});

/**
 * GET /api/security-master/bulk
 *
 * Internal endpoint: batch lookup SecurityMaster records.
 *
 * Query params:
 *   ?symbols=<string>  — Comma-separated ticker symbols (required)
 *
 * Returns: Array of SecurityMaster records
 */
router.get('/bulk', apiKeyAuth, async (req, res) => {
    const { symbols } = req.query;

    if (!symbols || typeof symbols !== 'string' || !symbols.trim()) {
        return res.status(400).json({ error: 'symbols query parameter is required' });
    }

    try {
        const symbolList = symbols.split(',').map(s => s.trim()).filter(Boolean);

        if (symbolList.length === 0) {
            return res.status(400).json({ error: 'No valid symbols provided' });
        }

        const records = await securityMasterService.getBySymbols(symbolList);
        res.status(200).json(records);
    } catch (error) {
        logger.error(`SecurityMaster bulk lookup failed: ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch SecurityMaster records' });
    }
});

/**
 * POST /api/security-master/refresh
 *
 * Internal endpoint: enqueue an on-demand refresh for a single symbol.
 *
 * Body: { symbol: string }
 *
 * Returns: 202 Accepted with job ID
 */
router.post('/refresh', apiKeyAuth, async (req, res) => {
    const { symbol } = req.body;

    if (!symbol || typeof symbol !== 'string' || !symbol.trim()) {
        return res.status(400).json({ error: 'symbol is required in request body' });
    }

    try {
        const { exchange } = req.body;
        const job = await enqueueSecurityMasterJob('refresh-single-symbol', { symbol: symbol.trim(), exchange: exchange || null });
        logger.info(`SecurityMaster refresh enqueued for ${symbol}`, { jobId: job.id });
        res.status(202).json({ message: 'Refresh job enqueued', jobId: job.id });
    } catch (error) {
        logger.error(`SecurityMaster refresh failed for "${symbol}": ${error.message}`);
        res.status(500).json({ error: 'Failed to enqueue refresh job' });
    }
});

/**
 * POST /api/security-master/refresh-all
 *
 * Internal endpoint: enqueue the full nightly refresh (all active stock symbols).
 * Useful for manual testing / backfills.
 *
 * Body: (none)
 *
 * Returns: 202 Accepted with job ID
 */
router.post('/refresh-all', apiKeyAuth, async (req, res) => {
    try {
        const job = await enqueueSecurityMasterJob('refresh-all-fundamentals', {});
        logger.info('SecurityMaster refresh-all enqueued', { jobId: job.id });
        res.status(202).json({ message: 'Full refresh job enqueued', jobId: job.id });
    } catch (error) {
        logger.error(`SecurityMaster refresh-all failed: ${error.message}`);
        res.status(500).json({ error: 'Failed to enqueue refresh-all job' });
    }
});

/**
 * POST /api/security-master/refresh-table
 *
 * Internal endpoint: refresh ALL symbols in the SecurityMaster table
 * (not just active portfolio items). Forces profile refresh for every record.
 * Useful for fixing stale exchange codes, backfilling missing data, etc.
 *
 * Body: (none)
 *
 * Returns: 202 Accepted with job ID
 */
router.post('/refresh-table', apiKeyAuth, async (req, res) => {
    try {
        const job = await enqueueSecurityMasterJob('refresh-all-from-table', {});
        logger.info('SecurityMaster refresh-table enqueued', { jobId: job.id });
        res.status(202).json({ message: 'Table refresh job enqueued', jobId: job.id });
    } catch (error) {
        logger.error(`SecurityMaster refresh-table failed: ${error.message}`);
        res.status(500).json({ error: 'Failed to enqueue table refresh job' });
    }
});

module.exports = router;
