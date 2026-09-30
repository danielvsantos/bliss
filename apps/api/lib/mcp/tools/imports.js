import { z } from 'zod';
import { defineTool, cursorField, limitField, stringId, intId, pathId } from '../define.js';
import { ToolInputError, errorMessage } from '../errors.js';
import { mapWithConcurrency } from '../loopback.js';
import { pageArgs, pageMeta, paginate, num, isoDate, signedAmount } from '../shape.js';

/**
 * Smart Import staged-import review (#89). Statement files are uploaded in the
 * Bliss app; agents review the staged rows and commit or cancel the import.
 */

const IMPORT_HINT = 'Use list_imports to find import and row IDs.';
const MAX_ROWS = 50;

function shapeRow(r) {
  return {
    rowId: r.id,
    rowNumber: r.rowNumber,
    date: isoDate(r.transactionDate),
    description: r.description,
    amount: { value: signedAmount(r), currency: r.currency },
    accountId: r.accountId,
    status: r.status,
    suggestedCategory: r.suggestedCategory
      ? { id: r.suggestedCategoryId, name: r.suggestedCategory.name, group: r.suggestedCategory.group, type: r.suggestedCategory.type }
      : null,
    confidence: r.confidence ?? null,
    classificationSource: r.classificationSource ?? null,
    details: r.details || null,
    tags: Array.isArray(r.tags) ? r.tags : [],
    requiresEnrichment: r.requiresEnrichment ?? false,
    ...(r.ticker && { ticker: r.ticker, assetQuantity: num(r.assetQuantity), assetPrice: num(r.assetPrice) }),
    ...(r.duplicateOfId && { duplicateOfTransactionId: r.duplicateOfId }),
    ...(r.updateTargetId && { updatesTransactionId: r.updateTargetId }),
    ...(r.errorMessage && { error: r.errorMessage }),
  };
}

const listImports = defineTool({
  name: 'list_imports',
  access: 'read',
  title: 'List staged imports',
  description:
    'Without importId: imports (uploaded statements) that still have rows to review. With importId: that '
    + 'import\'s status, row counts per status, category summary and a page of rows. Files are uploaded in the '
    + 'Bliss app — if nothing is pending, ask the user to upload the statement there first. Row statuses: '
    + 'PENDING (needs review), CONFIRMED (will be committed), POTENTIAL_DUPLICATE, DUPLICATE, SKIPPED, ERROR.',
  input: {
    importId: pathId().optional(),
    status: z.array(z.enum(['PENDING', 'CONFIRMED', 'POTENTIAL_DUPLICATE', 'DUPLICATE', 'SKIPPED', 'ERROR', 'STAGED']))
      .max(7).optional().describe('Only rows with these statuses (importId only).'),
    uncategorized: z.boolean().optional().describe('Only rows without a suggested category (importId only).'),
    categoryId: intId('Only rows suggested into this category (importId only).').optional(),
    limit: limitField(50),
    cursor: cursorField,
  },
  wraps: [
    { method: 'GET', route: '/api/imports/pending' },
    { method: 'GET', route: '/api/imports/[id]' },
  ],
  notFoundHint: IMPORT_HINT,
  async handler(args, { api }) {
    if (!args.importId) {
      const data = await api.get('/api/imports/pending');
      const imports = (data.imports || []).map((i) => ({
        importId: i.id,
        fileName: i.fileName,
        adapter: i.adapterName,
        accountId: i.accountId,
        totalRows: i.totalRows,
        rowsToReview: i.pendingRowCount,
        createdAt: i.createdAt,
      }));
      // Same list contract as every other tool: items + total + hasMore/nextCursor.
      return paginate(imports, args, 50);
    }
    const p = pageArgs(args, 50);
    const data = await api.get(`/api/imports/${encodeURIComponent(args.importId)}`, {
      page: p.page,
      limit: p.limit,
      status: args.status?.join(','),
      uncategorized: args.uncategorized ? 'true' : undefined,
      categoryId: args.categoryId,
    });
    const total = data.pagination?.total ?? 0;
    const imp = data.import || {};
    return {
      import: {
        importId: imp.id,
        status: imp.status,
        fileName: imp.fileName,
        accountId: imp.accountId,
        totalRows: imp.totalRows,
        rowsByStatus: imp.statusSummary,
        progress: imp.progress,
        seedReady: imp.seedReady,
      },
      categorySummary: (data.categorySummary || []).slice(0, 50).map((c) => ({
        categoryId: c.categoryId, category: c.category?.name ?? null, rows: c.count, bulkConfirmable: c.eligibleCount,
      })),
      rows: (data.rows || []).map(shapeRow),
      total,
      ...pageMeta(p, total),
    };
  },
});

const reviewImportRows = defineTool({
  name: 'review_import_rows',
  access: 'write',
  title: 'Review staged import rows',
  description:
    '`rows` (max 50): set a row\'s category, status (CONFIRMED to include it in the commit, SKIPPED to leave it '
    + 'out, PENDING to undo), account, details, tags or investment fields. `bulkConfirm`: confirm every '
    + 'reviewable row at once, or only those suggested into categoryId, or only uncategorised ones. '
    + 'Pass either rows or bulkConfirm. Commit afterwards with finalize_import.',
  input: {
    importId: stringId('Import ID from list_imports.'),
    rows: z.array(z.object({
      rowId: pathId(),
      categoryId: z.number().int().positive().optional(),
      status: z.enum(['CONFIRMED', 'SKIPPED', 'PENDING']).optional(),
      accountId: z.number().int().positive().optional(),
      details: z.string().max(1000).nullable().optional(),
      tags: z.array(z.string().min(1).max(100)).max(20).nullable().optional(),
      ticker: z.string().max(30).optional(),
      assetQuantity: z.number().optional(),
      assetPrice: z.number().optional(),
    })).max(MAX_ROWS).optional(),
    bulkConfirm: z.object({
      categoryId: z.number().int().positive().optional(),
      uncategorized: z.boolean().optional(),
    }).optional(),
  },
  wraps: [
    { method: 'PUT', route: '/api/imports/[id]/rows/[rowId]' },
    { method: 'POST', route: '/api/imports/[id]/bulk-confirm' },
  ],
  notFoundHint: IMPORT_HINT,
  async handler(args, { api }) {
    if (!args.rows?.length === !args.bulkConfirm) {
      throw new ToolInputError('Pass either rows or bulkConfirm (not both).');
    }
    const base = `/api/imports/${encodeURIComponent(args.importId)}`;
    if (args.bulkConfirm) {
      const result = await api.post(`${base}/bulk-confirm`, args.bulkConfirm);
      return { confirmed: result.confirmed };
    }
    const results = await mapWithConcurrency(args.rows, 10, async (row) => {
      const { rowId, categoryId, ...rest } = row;
      const body = { ...rest, ...(categoryId !== undefined && { suggestedCategoryId: categoryId }) };
      if (Object.keys(body).length === 0) return { rowId, ok: false, error: 'Nothing to change.' };
      try {
        const data = await api.put(`${base}/rows/${encodeURIComponent(rowId)}`, body);
        return { rowId, ok: true, status: data?.row?.status ?? null };
      } catch (err) {
        return { rowId, ok: false, error: errorMessage(err, { tool: 'review_import_rows', notFoundHint: IMPORT_HINT }) };
      }
    });
    return { results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  },
});

const listImportSeeds = defineTool({
  name: 'list_import_seeds',
  access: 'read',
  title: 'List import seeds',
  description:
    'The most frequent descriptions in a staged import with their suggested category — confirming these first '
    + 'categorises many rows at once (confirm_import_seeds).',
  input: {
    importId: stringId('Import ID from list_imports.'),
    limit: z.number().int().min(1).max(50).optional().describe('Max seeds (default 15).'),
  },
  wraps: [{ method: 'GET', route: '/api/imports/[id]/seeds' }],
  notFoundHint: IMPORT_HINT,
  async handler(args, { api }) {
    const seeds = await api.get(`/api/imports/${encodeURIComponent(args.importId)}/seeds`, { limit: args.limit });
    return {
      items: (seeds || []).map((s) => ({
        description: s.description,
        count: s.count,
        suggestedCategory: s.suggestedCategory
          ? { id: s.suggestedCategoryId, name: s.suggestedCategory.name, group: s.suggestedCategory.group }
          : null,
      })),
    };
  },
});

const confirmImportSeeds = defineTool({
  name: 'confirm_import_seeds',
  access: 'write',
  title: 'Confirm import seeds',
  description:
    'Confirm a category for each seed description: every PENDING/CONFIRMED row with that exact description gets '
    + 'the category and is marked CONFIRMED, and the classifier learns it.',
  input: {
    importId: stringId('Import ID from list_imports.'),
    seeds: z.array(z.object({
      description: z.string().min(1).max(500).describe('Exact description from list_import_seeds.'),
      categoryId: z.number().int().positive(),
    })).min(1).max(MAX_ROWS),
  },
  wraps: [{ method: 'POST', route: '/api/imports/[id]/confirm-seeds' }],
  notFoundHint: IMPORT_HINT,
  async handler(args, { api }) {
    const result = await api.post(`/api/imports/${encodeURIComponent(args.importId)}/confirm-seeds`, {
      seeds: args.seeds.map((s) => ({ description: s.description, confirmedCategoryId: s.categoryId })),
    });
    return { rowsConfirmed: result.confirmed };
  },
});

const finalizeImport = defineTool({
  name: 'finalize_import',
  access: 'write',
  destructive: true,
  title: 'Commit or cancel a staged import',
  description:
    'commit: create transactions from the import\'s CONFIRMED rows (optionally only rowIds); runs in the '
    + 'background — poll list_imports with importId for progress. cancel: discard the import and all its rows.',
  input: {
    importId: stringId('Import ID from list_imports.'),
    action: z.enum(['commit', 'cancel']),
    rowIds: z.array(z.string().min(1).max(100)).max(1000).optional().describe('commit only: a subset of rows.'),
  },
  wraps: [{ method: 'POST', route: '/api/imports/[id]' }],
  notFoundHint: IMPORT_HINT,
  async handler(args, { api }) {
    const result = await api.post(`/api/imports/${encodeURIComponent(args.importId)}`, {
      action: args.action,
      ...(args.action === 'commit' && args.rowIds?.length && { rowIds: args.rowIds }),
    });
    return args.action === 'commit'
      ? { importId: args.importId, status: result.status ?? 'COMMITTING', message: 'Commit started.' }
      : { importId: args.importId, status: 'CANCELLED' };
  },
});

const TOOLS = [listImports, reviewImportRows, listImportSeeds, confirmImportSeeds, finalizeImport];

export default TOOLS;
