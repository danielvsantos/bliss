const express = require('express');
const router = express.Router();
const apiKeyAuth = require('../middleware/apiKeyAuth');
const categorizationService = require('../services/categorizationService');
const geminiService = require('../services/geminiService');
const logger = require('../utils/logger');

/**
 * POST /api/admin/regenerate-embedding
 *
 * Re-generates the Gemini embedding for a single GlobalEmbedding description and
 * upserts it into the GlobalEmbedding table.
 *
 * Called by the Next.js admin API (`POST /api/admin/default-categories/[code]/regenerate-embeddings`)
 * once per description, sequentially.
 *
 * Body: {
 *   description:         string  — the normalized transaction description to re-embed
 *   defaultCategoryCode: string  — the SNAKE_UPPER_CASE code to associate with the embedding
 * }
 *
 * Auth: x-api-key header (INTERNAL_API_KEY) — same pattern as /api/feedback
 */
router.post('/regenerate-embedding', apiKeyAuth, async (req, res) => {
    const { description, defaultCategoryCode } = req.body;

    if (!description || typeof description !== 'string' || !description.trim()) {
        return res.status(400).json({ error: 'description is required and must be a non-empty string' });
    }

    if (!defaultCategoryCode || typeof defaultCategoryCode !== 'string') {
        return res.status(400).json({ error: 'defaultCategoryCode is required' });
    }

    try {
        const embedding = await geminiService.generateEmbedding(description.trim());
        await categorizationService.upsertGlobalEmbedding(description.trim(), defaultCategoryCode, embedding);

        logger.info(
            `[admin/regenerate-embedding] Regenerated embedding for "${description.substring(0, 60)}" → ${defaultCategoryCode}`
        );

        return res.status(200).json({ ok: true });
    } catch (error) {
        logger.error(
            `[admin/regenerate-embedding] Failed for "${description.substring(0, 60)}": ${error.message}`
        );
        return res.status(500).json({ error: 'Failed to regenerate embedding' });
    }
});

module.exports = router;
