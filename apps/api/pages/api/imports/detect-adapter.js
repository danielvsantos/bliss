import { StatusCodes } from 'http-status-codes';
import formidable from 'formidable';
import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import prisma from '../../../prisma/prisma.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { cors } from '../../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { withAuth } from '../../../utils/withAuth.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

// ─── Adapter Matching Logic ──────────────────────────────────────────────────
// Duplicated from adapterEngine.js (CJS) since finance-api is ESM.
// ~30 lines — intentionally kept inline to avoid cross-project coupling.

function sortAdaptersBySpecificity(adapters) {
  return adapters.sort((a, b) => {
    if (a.tenantId && !b.tenantId) return -1;
    if (!a.tenantId && b.tenantId) return 1;
    const aHeaders = a.matchSignature?.headers?.length || 0;
    const bHeaders = b.matchSignature?.headers?.length || 0;
    return bHeaders - aHeaders;
  });
}

function findMatchingAdapter(adapters, csvHeaders) {
  const normalizedCsvHeaders = new Set(csvHeaders.map((h) => h.trim().toLowerCase()));

  for (const adapter of adapters) {
    const adapterHeaders = adapter.matchSignature?.headers;
    if (!adapterHeaders || !Array.isArray(adapterHeaders)) continue;

    const allMatch = adapterHeaders.every((ah) =>
      normalizedCsvHeaders.has(ah.trim().toLowerCase())
    );

    if (allMatch) {
      const confidence = adapterHeaders.length / csvHeaders.length;
      return {
        matched: true,
        adapter: {
          id: adapter.id,
          name: adapter.name,
          columnMapping: adapter.columnMapping,
          dateFormat: adapter.dateFormat,
          amountStrategy: adapter.amountStrategy,
          currencyDefault: adapter.currencyDefault,
          skipRows: adapter.skipRows,
        },
        confidence: Math.round(confidence * 100) / 100,
      };
    }
  }

  return null;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.importsDetect(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  try {
    const user = req.user;

    const ALLOWED_MIME_TYPES = [
      'text/csv',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ];
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

    // Parse uploaded file
    const form = formidable({ multiples: false, keepExtensions: true, maxFileSize: MAX_FILE_SIZE });

    form.parse(req, async (err, fields, files) => {
      if (err) {
        const errMsg = err.code === 1009 ? 'File exceeds maximum allowed size of 10 MB' : 'File parsing error';
        return res.status(StatusCodes.BAD_REQUEST).json({ error: errMsg });
      }

      const file = files.file?.[0];
      if (!file || !file.filepath) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'No file uploaded' });
      }

      if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: `Unsupported file type "${file.mimetype}". Only CSV and XLSX files are accepted.`,
        });
      }

      try {
        // Detect file type from extension
        const ext = path.extname(file.originalFilename || file.filepath).toLowerCase();
        const isExcel = ext === '.xlsx' || ext === '.xls';

        let headers;
        let sampleRows;

        // Fetch adapters for this tenant (needed for both CSV and XLSX matching)
        const adapters = await prisma.importAdapter.findMany({
          where: {
            isActive: true,
            OR: [{ tenantId: user.tenantId }, { tenantId: null }],
          },
        });
        const sorted = sortAdaptersBySpecificity(adapters);

        if (isExcel) {
          // Read XLSX/XLS — try matching adapters across sheets (via ExcelJS)
          const buffer = fs.readFileSync(file.filepath);
          const workbook = new ExcelJS.Workbook();
          await workbook.xlsx.load(buffer);

          // Helper: extract clean headers + sample rows from a worksheet
          const extractSheet = (worksheet) => {
            if (!worksheet || worksheet.rowCount < 1) return null;
            const headerRow = worksheet.getRow(1);
            const sheetHeaders = [];
            headerRow.eachCell({ includeEmpty: true }, (cell) => {
              const val = cell.value !== null && cell.value !== undefined ? String(cell.value).trim() : '';
              if (val) sheetHeaders.push(val);
            });
            if (sheetHeaders.length === 0) return null;

            const sample = [];
            worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
              if (rowNumber === 1 || sample.length >= 3) return;
              const rowData = {};
              row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                const header = sheetHeaders[colNumber - 1];
                if (header) {
                  let value = cell.value;
                  if (value instanceof Date) value = isNaN(value.getTime()) ? '' : value.toISOString();
                  else if (value && typeof value === 'object' && value.text !== undefined) value = value.text;
                  else if (value && typeof value === 'object' && value.result !== undefined) value = value.result;
                  rowData[header] = value !== null && value !== undefined ? value : '';
                }
              });
              sample.push(rowData);
            });
            return { headers: sheetHeaders, sampleRows: sample };
          };

          // First pass: try adapters that specify a sheet name
          for (const adapter of sorted) {
            const adapterSheet = adapter.matchSignature?.sheet;
            if (adapterSheet) {
              const worksheet = workbook.getWorksheet(adapterSheet);
              if (!worksheet) continue;
              const data = extractSheet(worksheet);
              if (!data) continue;
              const result = findMatchingAdapter([adapter], data.headers);
              if (result) {
                return res.status(StatusCodes.OK).json(result);
              }
            }
          }

          // Second pass: try all sheets with all adapters
          for (const worksheet of workbook.worksheets) {
            const data = extractSheet(worksheet);
            if (!data || data.headers.length === 0) continue;
            const result = findMatchingAdapter(sorted, data.headers);
            if (result) {
              return res.status(StatusCodes.OK).json(result);
            }
          }

          // No adapter match — return headers from the first non-empty sheet
          const fallback = workbook.worksheets[0] ? extractSheet(workbook.worksheets[0]) : null;
          headers = fallback?.headers ?? [];
          sampleRows = fallback?.sampleRows ?? [];
        } else {
          // Read CSV — headers + first 3 rows only
          const fileContent = fs.readFileSync(file.filepath, 'utf8');
          const parsed = Papa.parse(fileContent, {
            header: true,
            skipEmptyLines: true,
            preview: 3,
            transformHeader: (h) => h.trim(),
          });

          headers = parsed.meta.fields || [];
          sampleRows = parsed.data || [];

          // Try matching CSV headers
          const result = findMatchingAdapter(sorted, headers);
          if (result) {
            return res.status(StatusCodes.OK).json(result);
          }
        }

        if (headers.length === 0) {
          return res.status(StatusCodes.BAD_REQUEST).json({
            error: 'Could not parse file headers. Ensure the file is a valid CSV or Excel file.',
          });
        }

        // No match — return headers and sample data for manual mapping
        return res.status(StatusCodes.OK).json({
          matched: false,
          headers,
          sampleData: sampleRows,
        });
      } catch (parseError) {
        Sentry.captureException(parseError);
        return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
          error: 'Failed to process file',
          details: parseError.message,
        });
      } finally {
        // Cleanup temp file
        try {
          fs.unlinkSync(file.filepath);
        } catch (cleanupErr) {
          // ignore
        }
      }
    });
  } catch (error) {
    Sentry.captureException(error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      details: error.message,
    });
  }
});
