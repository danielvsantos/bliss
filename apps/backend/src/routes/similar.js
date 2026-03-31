const express = require('express');
const router = express.Router();
const apiKeyAuth = require('../middleware/apiKeyAuth');
const geminiService = require('../services/geminiService');
const prisma = require('../../prisma/prisma');
const logger = require('../utils/logger');
const { DEFAULT_REVIEW_THRESHOLD } = require('../config/classificationConfig');

/**
 * GET /api/similar
 *
 * Internal endpoint: returns the top-5 TransactionEmbedding records most
 * similar to the provided description text, using pgvector cosine similarity.
 *
 * Query params:
 *   ?description=<string>   — Text to search for (required)
 *   ?tenantId=<string>      — Tenant to scope the search to (required)
 *   ?limit=<number>         — Max results to return (default: 5, max: 20)
 *   ?threshold=<number>     — Minimum similarity score 0.0–1.0 (default: 0.70)
 *
 * Returns: [{ categoryId, similarity, source, transactionId? }]
 */
router.get('/', apiKeyAuth, async (req, res) => {
  const { description, tenantId, limit = 5, threshold = DEFAULT_REVIEW_THRESHOLD } = req.query;

  if (!description || !tenantId) {
    return res.status(400).json({ error: 'description and tenantId are required' });
  }

  const maxResults = Math.min(Number(limit) || 5, 20);
  const minSimilarity = Math.max(0, Math.min(1, Number(threshold) || DEFAULT_REVIEW_THRESHOLD));

  try {
    const embedding = await geminiService.generateEmbedding(description);
    const vectorStr = `[${embedding.join(',')}]`;

    const results = await prisma.$queryRaw`
      SELECT
        te."id",
        te."transactionId",
        te."categoryId",
        te."source",
        1 - (te."embedding" <=> ${vectorStr}::vector) AS similarity
      FROM "TransactionEmbedding" te
      WHERE te."tenantId" = ${tenantId}
        AND te."embedding" IS NOT NULL
        AND 1 - (te."embedding" <=> ${vectorStr}::vector) >= ${minSimilarity}
      ORDER BY te."embedding" <=> ${vectorStr}::vector
      LIMIT ${maxResults}
    `;

    const formatted = results.map((r) => ({
      id: r.id,
      transactionId: r.transactionId,
      categoryId: r.categoryId,
      source: r.source,
      similarity: Number(r.similarity),
    }));

    logger.info(
      `Vector similarity search for "${description.substring(0, 50)}" ` +
      `(tenant ${tenantId}): ${formatted.length} results`
    );

    res.status(200).json(formatted);
  } catch (error) {
    logger.error(`Similar search failed for "${description}": ${error.message}`);
    res.status(500).json({ error: 'Failed to perform similarity search' });
  }
});

module.exports = router;
