const { getCategoriesForTenant } = require('../utils/categoryCache');
const { lookupDescription, addDescriptionEntry } = require('../utils/descriptionCache');
const { computeDescriptionHash } = require('../utils/descriptionHash');
const geminiService = require('./geminiService');
const prisma = require('../../prisma/prisma');
const logger = require('../utils/logger');
const {
    EXACT_MATCH_CONFIDENCE,
    GLOBAL_VECTOR_DISCOUNT,
} = require('../config/classificationConfig');

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORIZATION SERVICE
//
// 4-tier classification waterfall:
//   1. EXACT_MATCH          — O(1) lookup in the description→category cache
//                             (built from ALL tenant transactions including 20k+ historical)
//   2a. VECTOR_MATCH        — Cosine similarity against TransactionEmbedding via pgvector
//                             (tenant-scoped; top-1 match above reviewThreshold)
//   2b. VECTOR_MATCH_GLOBAL — Cosine similarity against GlobalEmbedding via pgvector
//                             (cross-tenant; confidence discounted by GLOBAL_VECTOR_DISCOUNT)
//   3.  LLM                 — Ask Gemini to classify against tenant's category list
//
// Returns: { categoryId, confidence, source }
//
// See src/config/classificationConfig.js for all tuning constants and the full
// confidence score reference table.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Classify a transaction description into a tenant's category.
 *
 * @param {string} description       — Transaction name/description
 * @param {string|null} merchantName — Optional merchant name for LLM context
 * @param {string} tenantId          — Tenant ID for category scoping
 * @param {number} [reviewThreshold=0.70] — Minimum cosine similarity to accept a vector match
 * @param {Object|null} [plaidCategory=null] — Optional Plaid personal_finance_category object
 * @returns {Promise<{categoryId: number, confidence: number, source: string, reasoning?: string}>}
 */
async function classify(description, merchantName, tenantId, reviewThreshold = 0.70, plaidCategory = null) {
  if (!description || !tenantId) {
    throw new Error('description and tenantId are required for classification');
  }

  // ─── Tier 1: Exact Match (O(1) description cache lookup) ───────────────────
  try {
    const matchedCategoryId = await lookupDescription(description, tenantId);
    if (matchedCategoryId) {
      logger.info(`EXACT_MATCH for "${description}" → categoryId ${matchedCategoryId} (tenant ${tenantId})`);
      return {
        categoryId: matchedCategoryId,
        confidence: EXACT_MATCH_CONFIDENCE,
        source: 'EXACT_MATCH',
      };
    }
  } catch (error) {
    logger.warn(`Exact match lookup failed, continuing to next tier: ${error.message}`);
  }

  // ─── Tier 2a + 2b: Vector Similarity ───────────────────────────────────────
  // Generate the embedding once; reuse for both tenant and global searches.
  let embedding = null;
  try {
    embedding = await geminiService.generateEmbedding(description);

    // ── Tier 2a: Tenant-scoped vector match ────────────────────────────────
    const vectorMatch = await findVectorMatch(embedding, tenantId, reviewThreshold);
    if (vectorMatch) {
      logger.info(
        `VECTOR_MATCH for "${description}" → categoryId ${vectorMatch.categoryId} ` +
        `(similarity: ${vectorMatch.confidence.toFixed(3)}, tenant ${tenantId})`
      );
      return {
        categoryId: vectorMatch.categoryId,
        confidence: vectorMatch.confidence,
        source: 'VECTOR_MATCH',
      };
    }

    // ── Tier 2b: Global cross-tenant vector match ──────────────────────────
    const globalMatch = await findGlobalVectorMatch(embedding, tenantId, reviewThreshold);
    if (globalMatch) {
      logger.info(
        `VECTOR_MATCH_GLOBAL for "${description}" → categoryId ${globalMatch.categoryId} ` +
        `(similarity: ${globalMatch.confidence.toFixed(3)}, code: ${globalMatch.defaultCategoryCode}, tenant ${tenantId})`
      );
      return {
        categoryId: globalMatch.categoryId,
        confidence: globalMatch.confidence,
        source: 'VECTOR_MATCH_GLOBAL',
      };
    }
  } catch (error) {
    logger.warn(`Vector search failed, falling through to LLM: ${error.message}`);
  }

  // ─── Tier 3: LLM Fallback ──────────────────────────────────────────────────
  try {
    const categories = await getCategoriesForTenant(tenantId);
    if (categories.length === 0) {
      throw new Error(`No categories found for tenant ${tenantId}`);
    }

    const llmResult = await geminiService.classifyTransaction(description, merchantName, categories, plaidCategory);
    logger.info(
      `LLM classified "${description}" → categoryId ${llmResult.categoryId} ` +
      `(confidence: ${llmResult.confidence.toFixed(2)}, reason: ${llmResult.reasoning})`
    );

    return {
      categoryId: llmResult.categoryId,
      confidence: llmResult.confidence,
      source: 'LLM',
      reasoning: llmResult.reasoning || null,
    };
  } catch (error) {
    logger.error(`LLM classification failed for "${description}": ${error.message}`);
    throw new Error(`All classification tiers failed for "${description}": ${error.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 2a — Tenant-scoped Vector Similarity
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Query the pgvector index for the closest matching embedding in the tenant's
 * TransactionEmbedding table.
 *
 * @param {number[]} embedding      — 768-dimensional float array from Gemini
 * @param {string}  tenantId
 * @param {number}  threshold       — Minimum cosine similarity (0.0–1.0) to accept
 * @returns {Promise<{categoryId: number, confidence: number}|null>}
 */
async function findVectorMatch(embedding, tenantId, threshold) {
  const vectorStr = `[${embedding.join(',')}]`;

  const results = await prisma.$queryRaw`
    SELECT te."categoryId",
           1 - (te."embedding" <=> ${vectorStr}::vector) AS similarity
    FROM "TransactionEmbedding" te
    WHERE te."tenantId" = ${tenantId}
      AND te."embedding" IS NOT NULL
    ORDER BY te."embedding" <=> ${vectorStr}::vector
    LIMIT 1
  `;

  if (results.length > 0 && Number(results[0].similarity) >= threshold) {
    return {
      categoryId: results[0].categoryId,
      confidence: Number(results[0].similarity),
    };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 2b — Global Cross-Tenant Vector Similarity
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Query the GlobalEmbedding table for the closest cross-tenant match, then
 * resolve the defaultCategoryCode to this tenant's local Category id.
 *
 * Confidence is discounted by GLOBAL_VECTOR_DISCOUNT to stay subordinate
 * to tenant-specific matches.  A match is only returned if the resolved
 * confidence still clears the tenant's reviewThreshold.
 *
 * @param {number[]} embedding — 768-dimensional float array from Gemini
 * @param {string}  tenantId
 * @param {number}  threshold  — Minimum cosine similarity before discount
 * @returns {Promise<{categoryId: number, confidence: number, defaultCategoryCode: string}|null>}
 */
async function findGlobalVectorMatch(embedding, tenantId, threshold) {
  const vectorStr = `[${embedding.join(',')}]`;

  const results = await prisma.$queryRaw`
    SELECT ge."defaultCategoryCode",
           1 - (ge."embedding" <=> ${vectorStr}::vector) AS similarity
    FROM "GlobalEmbedding" ge
    WHERE ge."embedding" IS NOT NULL
    ORDER BY ge."embedding" <=> ${vectorStr}::vector
    LIMIT 1
  `;

  if (!results.length) return null;

  const rawSimilarity = Number(results[0].similarity);
  const discountedConfidence = rawSimilarity * GLOBAL_VECTOR_DISCOUNT;

  // Only accept if the discounted confidence clears the threshold
  if (discountedConfidence < threshold) return null;

  // Map defaultCategoryCode → this tenant's local Category id
  const tenantCategory = await prisma.category.findFirst({
    where: {
      defaultCategoryCode: results[0].defaultCategoryCode,
      tenantId,
    },
    select: { id: true },
  });
  if (!tenantCategory) return null;

  return {
    categoryId: tenantCategory.id,
    confidence: discountedConfidence,
    defaultCategoryCode: results[0].defaultCategoryCode,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EMBEDDING UPSERT
//
// Stores or updates an embedding in TransactionEmbedding keyed by
// (tenantId, description). Called fire-and-forget by recordFeedback() and
// workers after LLM classification.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Upsert a TransactionEmbedding row with the given embedding vector.
 * Uses (tenantId, description) as the conflict key, where description
 * stores a SHA-256 hash of the normalised text (never plaintext).
 *
 * @param {string}   description    — Raw description (will be hashed before storage)
 * @param {number}   categoryId
 * @param {string}   tenantId
 * @param {number[]} embedding      — 768-dim float array
 * @param {string}   source         — 'USER_CONFIRMED' | 'AI_CLASSIFIED'
 * @param {number|null} [transactionId=null]
 */
async function upsertEmbedding(description, categoryId, tenantId, embedding, source, transactionId = null) {
  const descHash = computeDescriptionHash(description);
  const vectorStr = `[${embedding.join(',')}]`;
  const now = new Date();

  if (transactionId !== null) {
    // Upsert with transactionId — use description hash as conflict key, update transactionId if provided
    await prisma.$executeRaw`
      INSERT INTO "TransactionEmbedding"
        ("transactionId", "tenantId", "description", "categoryId", "confidence", "source", "embedding", "createdAt", "updatedAt")
      VALUES
        (${transactionId}, ${tenantId}, ${descHash}, ${categoryId}, 1.0, ${source}, ${vectorStr}::vector, ${now}, ${now})
      ON CONFLICT ("tenantId", "description")
      DO UPDATE SET
        "embedding"     = EXCLUDED."embedding",
        "categoryId"    = EXCLUDED."categoryId",
        "source"        = EXCLUDED."source",
        "transactionId" = COALESCE(EXCLUDED."transactionId", "TransactionEmbedding"."transactionId"),
        "updatedAt"     = EXCLUDED."updatedAt"
    `;
  } else {
    // Upsert without transactionId (staged/pre-commit rows)
    await prisma.$executeRaw`
      INSERT INTO "TransactionEmbedding"
        ("tenantId", "description", "categoryId", "confidence", "source", "embedding", "createdAt", "updatedAt")
      VALUES
        (${tenantId}, ${descHash}, ${categoryId}, 1.0, ${source}, ${vectorStr}::vector, ${now}, ${now})
      ON CONFLICT ("tenantId", "description")
      DO UPDATE SET
        "embedding"  = EXCLUDED."embedding",
        "categoryId" = EXCLUDED."categoryId",
        "source"     = EXCLUDED."source",
        "updatedAt"  = EXCLUDED."updatedAt"
    `;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL EMBEDDING UPSERT
//
// Stores a cross-tenant (description, defaultCategoryCode, embedding) triple in
// GlobalEmbedding.  Keyed by normalized description — last writer wins.
// Only called for default categories (defaultCategoryCode != null).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Upsert a GlobalEmbedding row.
 * The description column stores a SHA-256 hash (never plaintext).
 *
 * @param {string}   description          — Raw description (will be hashed before storage)
 * @param {string}   defaultCategoryCode  — SNAKE_UPPER_CASE code from Category
 * @param {number[]} embedding            — 768-dim float array
 */
async function upsertGlobalEmbedding(description, defaultCategoryCode, embedding) {
  const descHash = computeDescriptionHash(description);
  const vectorStr = `[${embedding.join(',')}]`;
  const now = new Date();

  await prisma.$executeRaw`
    INSERT INTO "GlobalEmbedding" ("description", "defaultCategoryCode", "embedding", "createdAt", "updatedAt")
    VALUES (${descHash}, ${defaultCategoryCode}, ${vectorStr}::vector, ${now}, ${now})
    ON CONFLICT ("description")
    DO UPDATE SET
      "defaultCategoryCode" = EXCLUDED."defaultCategoryCode",
      "embedding"           = EXCLUDED."embedding",
      "updatedAt"           = EXCLUDED."updatedAt"
  `;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FEEDBACK LOOP
//
// Called whenever a user overrides a category on any transaction.
// 1. Updates the in-memory description cache (Tier 1 hit on next call).
// 2. Asynchronously generates an embedding and upserts TransactionEmbedding
//    (Tier 2a hit on future calls from the same tenant with similar descriptions).
// 3. If the category is a default one (has a defaultCategoryCode), also upserts
//    GlobalEmbedding (Tier 2b hit for any tenant with that default category).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record a user category correction as a training signal.
 *
 * @param {string}      description   — Raw transaction description that was overridden
 * @param {number}      categoryId    — The corrected category ID chosen by the user
 * @param {string}      tenantId
 * @param {number|null} [transactionId=null] — The committed Transaction.id if available
 */
async function recordFeedback(description, categoryId, tenantId, transactionId = null) {
  if (!description || !categoryId || !tenantId) {
    logger.warn('recordFeedback: missing required parameters — skipping');
    return;
  }

  try {
    // 1. Update the in-memory cache immediately — next EXACT_MATCH lookup will hit
    addDescriptionEntry(description, categoryId, tenantId);
    logger.info(`Feedback recorded for tenant ${tenantId}: "${description}" → category ${categoryId}`);
  } catch (error) {
    logger.error(`recordFeedback cache update failed for "${description}": ${error.message}`);
  }

  // 2 + 3. Fire-and-forget: generate embedding → upsert tenant + global embeddings
  geminiService.generateEmbedding(description)
    .then(async (embedding) => {
      // 2. Upsert tenant-scoped TransactionEmbedding
      await upsertEmbedding(description, categoryId, tenantId, embedding, 'USER_CONFIRMED', transactionId);

      // 3. Conditionally upsert GlobalEmbedding for default categories
      try {
        const cat = await prisma.category.findUnique({
          where: { id: categoryId },
          select: { defaultCategoryCode: true },
        });
        if (cat?.defaultCategoryCode) {
          await upsertGlobalEmbedding(description, cat.defaultCategoryCode, embedding);
        }
      } catch (globalErr) {
        // Non-fatal — global embeddings build up over time
        logger.warn(`GlobalEmbedding upsert failed for "${description}": ${globalErr.message}`);
      }
    })
    .catch((error) => {
      // Non-fatal — vector tier will build up over time; Tier 1 already updated above
      logger.warn(`Embedding upsert failed for "${description}" (tenant ${tenantId}): ${error.message}`);
    });
}

module.exports = {
  classify,
  recordFeedback,
  upsertEmbedding,
  upsertGlobalEmbedding,
  findGlobalVectorMatch,
};
