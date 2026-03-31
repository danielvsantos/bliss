/**
 * POST /api/admin/default-categories/[code]/regenerate-embeddings
 *
 * Regenerates the Gemini embedding vectors for all confirmed transactions
 * whose category belongs to the given defaultCategoryCode.
 *
 * Descriptions are sourced from the Transaction table (auto-decrypted by
 * Prisma middleware) because GlobalEmbedding.description stores a SHA-256 hash,
 * not the original plaintext.
 *
 * Use cases:
 *   - After a Gemini model upgrade: refresh all vectors with the new model's output
 *   - After a code rename: verify renamed rows still classify correctly
 *   - Periodic quality refresh
 *
 * Proxies to: POST BACKEND_URL/api/admin/regenerate-embedding (per description, sequential)
 *
 * Auth: x-admin-key header (ADMIN_API_KEY env var) — same pattern as plaid/items/hard-delete.js
 */

import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../../../prisma/prisma';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const BACKEND_API_KEY = process.env.INTERNAL_API_KEY || '';

// ── Admin key validation (mirrors plaid/items/hard-delete.js) ──────────────

function isAdminAuthorized(req) {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    console.warn('[admin/regenerate-embeddings] ADMIN_API_KEY env var is not set — rejecting all requests');
    return false;
  }
  const provided = req.headers['x-admin-key'];
  return provided === adminKey;
}

// ── Route handler ──────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(StatusCodes.OK).end();

  if (!isAdminAuthorized(req)) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  const { code } = req.query;

  try {
    // Find all categories that use this defaultCategoryCode
    const categories = await prisma.category.findMany({
      where: { defaultCategoryCode: code },
      select: { id: true },
    });

    if (categories.length === 0) {
      return res.status(StatusCodes.OK).json({
        regenerated: 0,
        failed: 0,
        message: `No categories found with code '${code}'. Nothing to regenerate.`,
      });
    }

    const categoryIds = categories.map((c) => c.id);

    // Source descriptions from Transaction table (Prisma ORM auto-decrypts).
    // GlobalEmbedding.description stores a SHA-256 hash, not plaintext,
    // so we source from the canonical encrypted Transaction records instead.
    const transactions = await prisma.transaction.findMany({
      where: { categoryId: { in: categoryIds } },
      select: { description: true },
      distinct: ['description'],
      take: 1000,
    });

    // Deduplicate after decryption (normalised)
    const uniqueDescriptions = [
      ...new Set(
        transactions
          .map((t) => t.description?.toLowerCase().trim())
          .filter(Boolean)
      ),
    ];

    if (uniqueDescriptions.length === 0) {
      return res.status(StatusCodes.OK).json({
        regenerated: 0,
        failed: 0,
        message: `No transactions found for code '${code}'. Nothing to regenerate.`,
      });
    }

    console.log(
      `[admin/regenerate-embeddings] Starting regeneration for '${code}': ${uniqueDescriptions.length} unique description(s)`
    );

    let regenerated = 0;
    let failed = 0;

    // Process sequentially — this is an admin operation, not time-critical.
    // Sequential approach avoids hammering Gemini API and gives clear per-row error logging.
    for (const description of uniqueDescriptions) {
      try {
        const backendRes = await fetch(`${BACKEND_URL}/api/admin/regenerate-embedding`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': BACKEND_API_KEY,
          },
          body: JSON.stringify({ description, defaultCategoryCode: code }),
        });

        if (!backendRes.ok) {
          const errText = await backendRes.text();
          console.error(
            `[admin/regenerate-embeddings] Backend returned ${backendRes.status} for "${description.substring(0, 60)}": ${errText}`
          );
          failed++;
        } else {
          regenerated++;
        }
      } catch (rowErr) {
        console.error(
          `[admin/regenerate-embeddings] Network error for "${description.substring(0, 60)}":`,
          rowErr.message
        );
        failed++;
      }
    }

    console.log(
      `[admin/regenerate-embeddings] Done for '${code}': ${regenerated} regenerated, ${failed} failed`
    );

    return res.status(StatusCodes.OK).json({ regenerated, failed });
  } catch (error) {
    Sentry.captureException(error);
    console.error(`[admin/regenerate-embeddings] Failed for code '${code}':`, error.message);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Regeneration failed',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
}
