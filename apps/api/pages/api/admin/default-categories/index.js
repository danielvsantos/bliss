/**
 * GET  /api/admin/default-categories
 *   List all default categories with live DB stats (tenant count + global embedding count).
 *
 * POST /api/admin/default-categories
 *   Provision a new default category to ALL existing tenants that don't already have it.
 *   Body: { code, name, group, type, icon?, processingHint?, portfolioItemKeyStrategy? }
 *   Note: does NOT update defaultCategories.js — update the file manually so new
 *   signups also receive the category.
 *
 * Auth: x-admin-key header (ADMIN_API_KEY env var) — same pattern as plaid/items/hard-delete.js
 */

import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../../prisma/prisma';
import { DEFAULT_CATEGORIES } from '../../../../lib/defaultCategories';

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
    console.warn('[admin/default-categories] ADMIN_API_KEY env var is not set — rejecting all requests');
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

  // ── GET — list default categories with live DB stats ─────────────────────

  if (req.method === 'GET') {
    try {
      // Count Category rows per code across all tenants
      const categoryCounts = await prisma.$queryRaw`
        SELECT "defaultCategoryCode", COUNT(*)::int AS count
        FROM "Category"
        WHERE "defaultCategoryCode" IS NOT NULL
        GROUP BY "defaultCategoryCode"
      `;

      // Count GlobalEmbedding rows per code
      const embeddingCounts = await prisma.$queryRaw`
        SELECT "defaultCategoryCode", COUNT(*)::int AS count
        FROM "GlobalEmbedding"
        WHERE "defaultCategoryCode" IS NOT NULL
        GROUP BY "defaultCategoryCode"
      `;

      const categoryCountMap = Object.fromEntries(
        categoryCounts.map(r => [r.defaultCategoryCode, Number(r.count)])
      );
      const embeddingCountMap = Object.fromEntries(
        embeddingCounts.map(r => [r.defaultCategoryCode, Number(r.count)])
      );

      const result = DEFAULT_CATEGORIES.map(cat => ({
        code: cat.code,
        name: cat.name,
        group: cat.group,
        type: cat.type,
        icon: cat.icon ?? null,
        processingHint: cat.processingHint ?? null,
        portfolioItemKeyStrategy: cat.portfolioItemKeyStrategy ?? 'IGNORE',
        tenantCount: categoryCountMap[cat.code] ?? 0,
        globalEmbeddingCount: embeddingCountMap[cat.code] ?? 0,
      }));

      return res.status(StatusCodes.OK).json(result);
    } catch (error) {
      Sentry.captureException(error);
      console.error('[admin/default-categories] GET failed:', error.message);
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'Failed to fetch default categories',
        ...(process.env.NODE_ENV === 'development' && { details: error.message }),
      });
    }
  }

  // ── POST — provision a new default category to all existing tenants ───────

  if (req.method === 'POST') {
    const { code, name, group, type, icon, processingHint, portfolioItemKeyStrategy } = req.body ?? {};

    // Validate required fields
    if (!code || !name || !group || !type) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'code, name, group, and type are required',
      });
    }

    // Validate code format: SNAKE_UPPER_CASE only
    if (!/^[A-Z0-9_]+$/.test(code)) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'code must be SNAKE_UPPER_CASE (uppercase letters, digits, and underscores only)',
      });
    }

    if (portfolioItemKeyStrategy && !ALLOWED_PORTFOLIO_STRATEGIES.includes(portfolioItemKeyStrategy)) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: `portfolioItemKeyStrategy must be one of: ${ALLOWED_PORTFOLIO_STRATEGIES.join(', ')}`,
      });
    }

    // Guard: code must not already be in use
    const existingCount = await prisma.category.count({
      where: { defaultCategoryCode: code },
    });
    if (existingCount > 0) {
      return res.status(StatusCodes.CONFLICT).json({
        error: `A category with code '${code}' already exists in ${existingCount} tenant row(s). Use PUT /api/admin/default-categories/${code} to update it.`,
      });
    }

    try {
      const allTenants = await prisma.tenant.findMany({ select: { id: true } });

      const result = await prisma.category.createMany({
        data: allTenants.map(t => ({
          defaultCategoryCode: code,
          name,
          group,
          type,
          icon: icon ?? null,
          processingHint: processingHint ?? null,
          portfolioItemKeyStrategy: portfolioItemKeyStrategy ?? 'IGNORE',
          tenantId: t.id,
        })),
        skipDuplicates: true, // skip if tenant already has a category with this name
      });

      console.log(
        `[admin/default-categories] POST: provisioned '${code}' ('${name}') to ${result.count} tenant(s)`
      );

      return res.status(StatusCodes.CREATED).json({
        provisioned: result.count,
        note: "Remember to add this category to defaultCategories.js so future signups also receive it.",
      });
    } catch (error) {
      Sentry.captureException(error);
      console.error('[admin/default-categories] POST failed:', error.message);
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'Failed to provision category',
        ...(process.env.NODE_ENV === 'development' && { details: error.message }),
      });
    }
  }

  res.setHeader('Allow', ['GET', 'POST']);
  return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
}
