import { StatusCodes } from 'http-status-codes';
import prisma from '../../../prisma/prisma.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { cors } from '../../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { withAuth } from '../../../utils/withAuth.js';

const EXPORT_BATCH_SIZE = 1000;

export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.transactions(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  try {
    const tenantId = req.user.tenantId;

    // Build WHERE from query params (same filter set as GET /api/transactions)
    const {
      year, month, quarter, categoryId, accountId,
      currencyCode, accountCountry, tags, 'tags[]': tagsArray,
      group, type, source, startDate, endDate,
    } = req.query;

    const normalizedTags = tagsArray || (Array.isArray(tags) ? tags : tags ? [tags] : null);

    const where = {
      tenantId,
      ...(year && { year: parseInt(year, 10) }),
      ...(month && { month: parseInt(month, 10) }),
      ...(quarter && { quarter }),
      ...(categoryId && { categoryId: parseInt(categoryId, 10) }),
      ...(accountId && { accountId: parseInt(accountId, 10) }),
      ...(currencyCode && { currency: currencyCode.toUpperCase() }),
      ...(accountCountry && { account: { countryId: accountCountry.toUpperCase() } }),
      ...(normalizedTags && {
        tags: {
          some: {
            tag: {
              OR: normalizedTags.map((tag) => ({
                OR: [
                  { id: !isNaN(parseInt(tag, 10)) ? parseInt(tag, 10) : undefined },
                  { name: typeof tag === 'string' ? tag : undefined },
                ],
              })),
            },
          },
        },
      }),
      ...(group && { category: { group } }),
      ...(type && { category: { type } }),
      ...(source && { source }),
      ...(startDate || endDate
        ? {
            transaction_date: {
              ...(startDate && { gte: new Date(startDate) }),
              ...(endDate && { lte: new Date(endDate + 'T23:59:59.999Z') }),
            },
          }
        : {}),
    };

    const include = {
      account: { select: { name: true } },
      category: { select: { name: true } },
      tags: { include: { tag: { select: { name: true } } } },
    };

    // Get total count for header
    const totalCount = await prisma.transaction.count({ where });

    // Set response headers and start streaming
    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bliss-export-${today}.csv"`);
    res.setHeader('X-Total-Count', String(totalCount));
    res.setHeader('Transfer-Encoding', 'chunked');

    // Write BOM + headers
    const BOM = '\uFEFF';
    const headers = 'id,transactiondate,description,debit,credit,account,category,currency,details,ticker,assetquantity,assetprice,tags';
    res.write(BOM + headers + '\n');

    // Cursor-based batched fetch
    let cursor = undefined;

    while (true) {
      const batch = await prisma.transaction.findMany({
        where,
        include,
        orderBy: { id: 'asc' },
        take: EXPORT_BATCH_SIZE,
        ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      });

      if (batch.length === 0) break;

      for (const tx of batch) {
        const tagStr = (tx.tags || []).map((t) => t.tag.name).join('|');
        const row = [
          tx.id,
          tx.transaction_date ? new Date(tx.transaction_date).toISOString().slice(0, 10) : '',
          csvEscape(tx.description || ''),
          tx.debit ?? '',
          tx.credit ?? '',
          csvEscape(tx.account?.name || ''),
          csvEscape(tx.category?.name || ''),
          tx.currency || '',
          csvEscape(tx.details || ''),
          tx.ticker || '',
          tx.assetQuantity ?? '',
          tx.assetPrice ?? '',
          csvEscape(tagStr),
        ].join(',');
        res.write(row + '\n');
      }

      cursor = batch[batch.length - 1].id;
      if (batch.length < EXPORT_BATCH_SIZE) break;
    }

    return res.end();
  } catch (error) {
    Sentry.captureException(error);
    if (!res.headersSent) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'Export failed',
        details: error.message,
      });
    }
    res.end();
  }
});

function csvEscape(value) {
  if (!value) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
