const express = require('express');
const router = express.Router();
const categorizationService = require('../services/categorizationService');
const apiKeyAuth = require('../middleware/apiKeyAuth');
const logger = require('../utils/logger');

/**
 * POST /api/feedback
 *
 * Internal endpoint called by the finance API whenever a user overrides a
 * category on any transaction (Plaid review, import review, or manual edit).
 *
 * Body: {
 *   description: string,
 *   categoryId: number,
 *   tenantId: string,
 *   transactionId?: number  // Optional — the committed Transaction.id if available
 * }
 *
 * 1. Updates the in-memory description cache immediately (Tier 1 EXACT_MATCH).
 * 2. Fire-and-forget: generates a Gemini embedding and upserts TransactionEmbedding
 *    (builds the vector search index for Tier 2 VECTOR_MATCH).
 */
router.post('/', apiKeyAuth, async (req, res) => {
    const { description, categoryId, tenantId, transactionId } = req.body;

    if (!description || !categoryId || !tenantId) {
        return res.status(400).json({ error: 'description, categoryId, and tenantId are required' });
    }

    if (typeof categoryId !== 'number' || !Number.isInteger(categoryId) || categoryId <= 0) {
        return res.status(400).json({ error: 'categoryId must be a positive integer' });
    }

    const parsedTransactionId = transactionId != null ? Number(transactionId) : null;

    try {
        await categorizationService.recordFeedback(description, categoryId, tenantId, parsedTransactionId);
        logger.info(`Feedback accepted: tenant=${tenantId} category=${categoryId} desc="${description.substring(0, 50)}"`);
        res.status(200).json({ message: 'Feedback recorded' });
    } catch (error) {
        logger.error(`Feedback processing failed: ${error.message}`);
        res.status(500).json({ error: 'Failed to record feedback' });
    }
});

/**
 * POST /api/feedback/batch
 *
 * Batch variant — accepts multiple feedback entries in a single request.
 * Used by the bulk-promote endpoint to avoid N individual HTTP calls.
 *
 * Body: {
 *   tenantId: string,
 *   entries: [{ description: string, categoryId: number, transactionId?: number }]
 * }
 */
router.post('/batch', apiKeyAuth, async (req, res) => {
    const { tenantId, entries } = req.body;

    if (!tenantId || !Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ error: 'tenantId and a non-empty entries array are required' });
    }

    let accepted = 0;
    let failed = 0;

    for (const entry of entries) {
        const { description, categoryId, transactionId } = entry;
        if (!description || !categoryId) { failed++; continue; }

        const parsedCategoryId = Number(categoryId);
        if (!Number.isInteger(parsedCategoryId) || parsedCategoryId <= 0) { failed++; continue; }

        const parsedTransactionId = transactionId != null ? Number(transactionId) : null;

        try {
            await categorizationService.recordFeedback(description, parsedCategoryId, tenantId, parsedTransactionId);
            accepted++;
        } catch (error) {
            logger.error(`Batch feedback entry failed: ${error.message}`);
            failed++;
        }
    }

    logger.info(`Batch feedback: tenant=${tenantId} accepted=${accepted} failed=${failed}`);
    res.status(200).json({ accepted, failed });
});

module.exports = router;
