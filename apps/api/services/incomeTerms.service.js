import { Decimal } from '@prisma/client/runtime/library';
import prisma from '../prisma/prisma.js';
import { validateIncomeTerms, isStreamEligibleCategory } from '@bliss/shared/portfolio';

/**
 * Income terms helpers shared by the asset, stream and detached-terms routes.
 *
 * `toIncomeTermsData()` whitelists and converts a request body into Prisma
 * data. Owner fields (tenantId, assetId, categoryId, orphanedAt,
 * orphanedLabel) are never taken from the body — each route sets them.
 */

const DECIMAL_FIELDS = [
  'amountPerPayment',
  'dividendPerUnit',
  'yieldPct',
  'faceValuePerUnit',
  'couponRate',
  'spread',
  'assumedIndexRate',
  'monthlyRent',
  'annualIndexationPct',
  'apyPct',
];

const DATE_FIELDS = ['anchorPaymentDate', 'startDate', 'endDate', 'maturityDate', 'leaseEndDate'];

const STRING_FIELDS = ['frequency', 'currency', 'issuerType', 'referenceIndex'];

function blank(v) {
  return v === undefined || v === null || v === '';
}

/**
 * Validate a body. Returns `null` when valid, else a 400-ready error object.
 * @param {Object} body
 * @param {'asset'|'stream'} mode
 */
export function validateBody(body, mode) {
  const errors = validateIncomeTerms(body, { mode });
  if (errors.length === 0) return null;
  return { error: errors[0].message, details: errors };
}

/**
 * Convert a validated body into Prisma data. Every field is written (null when
 * absent) so switching income types never leaves stale values behind.
 */
export function toIncomeTermsData(body) {
  const data = {
    incomeType: body.incomeType,
    isDistributing: body.isDistributing !== false && body.incomeType !== 'NONE',
    name: blank(body.name) ? null : String(body.name).trim(),
  };
  for (const f of DECIMAL_FIELDS) data[f] = blank(body[f]) ? null : new Decimal(String(body[f]));
  for (const f of DATE_FIELDS) data[f] = blank(body[f]) ? null : new Date(body[f]);
  for (const f of STRING_FIELDS) data[f] = blank(body[f]) ? null : String(body[f]);
  if (data.currency) data.currency = data.currency.toUpperCase();
  return data;
}

/** Plain-JSON view of an IncomeTerms row (Decimals → numbers). */
export function serializeIncomeTerms(row) {
  if (!row) return null;
  const out = { ...row };
  for (const f of DECIMAL_FIELDS) out[f] = row[f] == null ? null : Number(row[f].toString());
  return out;
}

// ─── Streams ─────────────────────────────────────────────────────────────────

export const STREAM_CATEGORY_SELECT = {
  id: true,
  name: true,
  type: true,
  group: true,
  processingHint: true,
  portfolioItemKeyStrategy: true,
  defaultCategoryCode: true,
};

export function serializeStream(row) {
  const out = serializeIncomeTerms(row);
  if (row?.category) {
    out.categoryName = row.category.name;
    out.categoryCode = row.category.defaultCategoryCode || null;
    delete out.category;
  }
  return out;
}

export async function findEligibleCategory(tenantId, categoryId) {
  const id = parseInt(categoryId, 10);
  if (Number.isNaN(id)) return null;
  const category = await prisma.category.findFirst({
    where: { id, tenantId },
    select: STREAM_CATEGORY_SELECT,
  });
  return isStreamEligibleCategory(category) ? category : null;
}
