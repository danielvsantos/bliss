/**
 * PUT /api/admin/default-categories/[code]
 *
 * Pushes metadata changes to ALL tenant Category rows that share this defaultCategoryCode,
 * and optionally renames the code itself (propagating the rename to GlobalEmbedding too).
 *
 * Body (all fields optional):
 *   name                  — display name
 *   group                 — category group
 *   type                  — category type
 *   icon                  — emoji icon
 *   portfolioItemKeyStrategy — one of TICKER | CATEGORY_NAME | CATEGORY_NAME_PLUS_DESCRIPTION | IGNORE | CURRENCY
 *   newCode               — rename the code (updates Category + GlobalEmbedding rows)
 *
 * Protected field: processingHint — immutable, rejected with 400 if included.
 *
 * Auth: x-admin-key header (ADMIN_API_KEY env var) — same pattern as plaid/items/hard-delete.js
 */

import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../../prisma/prisma';

const ALLOWED_PORTFOLIO_STRATEGIES = [
  'TICKER',
  'CATEGORY_NAME',
  'CATEGORY_NAME_PLUS_DESCRIPTION',
  'IGNORE',
  'CURRENCY',
];

// ── Admin key validation (mirrors plaid/items/hard-delete.js) ──────────────

function isAdminAuthorized(req) {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    console.warn('[admin/default-categories/[code]] ADMIN_API_KEY env var is not set — rejecting all requests');
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

  if (req.method !== 'PUT') {
    res.setHeader('Allow', ['PUT']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  const { code } = req.query;
  const body = req.body ?? {};

  // ── Guard: processingHint is immutable ────────────────────────────────────
  if ('processingHint' in body) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'processingHint is managed by the system and cannot be updated via this API.',
    });
  }

  // ── Validate optional fields ──────────────────────────────────────────────
  const { name, group, type, icon, portfolioItemKeyStrategy, newCode } = body;

  if (
    portfolioItemKeyStrategy !== undefined &&
    !ALLOWED_PORTFOLIO_STRATEGIES.includes(portfolioItemKeyStrategy)
  ) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: `portfolioItemKeyStrategy must be one of: ${ALLOWED_PORTFOLIO_STRATEGIES.join(', ')}`,
    });
  }

  if (newCode !== undefined && !/^[A-Z0-9_]+$/.test(newCode)) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'newCode must be SNAKE_UPPER_CASE (uppercase letters, digits, and underscores only)',
    });
  }

  // Build metadata patch (only include fields explicitly provided)
  const metadataPatch = {};
  if (name !== undefined) metadataPatch.name = name;
  if (group !== undefined) metadataPatch.group = group;
  if (type !== undefined) metadataPatch.type = type;
  if (icon !== undefined) metadataPatch.icon = icon;
  if (portfolioItemKeyStrategy !== undefined) metadataPatch.portfolioItemKeyStrategy = portfolioItemKeyStrategy;

  const hasMetadataChanges = Object.keys(metadataPatch).length > 0;
  const hasCodeRename = newCode !== undefined && newCode !== code;

  if (!hasMetadataChanges && !hasCodeRename) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'No changes provided. Supply at least one field to update.',
    });
  }

  try {
    // ── Check target code exists ───────────────────────────────────────────
    const existingCount = await prisma.category.count({
      where: { defaultCategoryCode: code },
    });

    if (existingCount === 0) {
      return res.status(StatusCodes.NOT_FOUND).json({
        error: `No categories found with defaultCategoryCode '${code}'.`,
      });
    }

    let updatedTenantCategories = 0;
    let globalEmbeddingsRenamed = 0;

    // ── Step 1: Push metadata changes to all tenant Category rows ─────────
    if (hasMetadataChanges) {
      const metaResult = await prisma.category.updateMany({
        where: { defaultCategoryCode: code },
        data: metadataPatch,
      });
      updatedTenantCategories = metaResult.count;
    }

    // ── Step 2: Rename code (Category rows + GlobalEmbedding rows) ────────
    if (hasCodeRename) {
      // Guard: ensure newCode is not already taken
      const conflictCount = await prisma.category.count({
        where: { defaultCategoryCode: newCode },
      });
      if (conflictCount > 0) {
        return res.status(StatusCodes.CONFLICT).json({
          error: `Cannot rename to '${newCode}': that code is already used by ${conflictCount} category row(s).`,
        });
      }

      // Update Category rows with the new code
      const renameResult = await prisma.category.updateMany({
        where: { defaultCategoryCode: code },
        data: { defaultCategoryCode: newCode },
      });
      updatedTenantCategories = Math.max(updatedTenantCategories, renameResult.count);

      // Update GlobalEmbedding rows to point to the new code
      const geResult = await prisma.globalEmbedding.updateMany({
        where: { defaultCategoryCode: code },
        data: { defaultCategoryCode: newCode },
      });
      globalEmbeddingsRenamed = geResult.count;
    }

    console.log(
      `[admin/default-categories/[code]] PUT '${code}'` +
      (hasCodeRename ? ` → renamed to '${newCode}'` : '') +
      `: ${updatedTenantCategories} tenant categories updated, ${globalEmbeddingsRenamed} GlobalEmbedding rows renamed`
    );

    return res.status(StatusCodes.OK).json({
      updatedTenantCategories,
      globalEmbeddingsRenamed,
      ...(hasCodeRename && { renamedTo: newCode }),
      note: "Remember to update defaultCategories.js to keep new signups consistent.",
    });
  } catch (error) {
    Sentry.captureException(error);
    console.error(`[admin/default-categories/[code]] PUT '${code}' failed:`, error.message);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to update default category',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
}
