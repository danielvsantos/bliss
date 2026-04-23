const Papa = require('papaparse');
const ExcelJS = require('exceljs');
const prisma = require('../../prisma/prisma');
const logger = require('../utils/logger');
const { getRedisConnection } = require('../utils/redis');

const ADAPTER_CACHE_TTL = 300; // 5 minutes

// ═══════════════════════════════════════════════════════════════════════════════
// ADAPTER ENGINE
//
// Core logic for CSV adapter detection and file parsing.
// Used by the smart import worker to:
//   1. Detect which adapter matches a given CSV's headers
//   2. Parse/normalize raw CSV rows into a standard format
//
// Adapters are cached in Redis per-tenant (includes global adapters).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch all active adapters accessible by a tenant (tenant-specific + global).
 * Results are cached in Redis for 5 minutes.
 *
 * @param {string} tenantId
 * @returns {Promise<Array>} — Sorted: tenant-specific first, then by header count desc
 */
async function getAdaptersForTenant(tenantId) {
  const redis = getRedisConnection();
  const cacheKey = `adapters:${tenantId}`;

  // Try Redis cache first
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (err) {
    logger.warn(`Redis cache read failed for adapters: ${err.message}`);
  }

  // Cache miss — query DB
  const adapters = await prisma.importAdapter.findMany({
    where: {
      isActive: true,
      OR: [
        { tenantId },
        { tenantId: null },
      ],
    },
  });

  // Sort: tenant-specific first, then by header count (more specific = higher priority)
  const sorted = sortAdaptersBySpecificity(adapters);

  // Cache in Redis
  try {
    await redis.set(cacheKey, JSON.stringify(sorted), 'EX', ADAPTER_CACHE_TTL);
  } catch (err) {
    logger.warn(`Redis cache write failed for adapters: ${err.message}`);
  }

  return sorted;
}

/**
 * Sort adapters: tenant-specific before global, then by number of match headers descending.
 */
function sortAdaptersBySpecificity(adapters) {
  return adapters.sort((a, b) => {
    // Tenant-specific before global
    if (a.tenantId && !b.tenantId) return -1;
    if (!a.tenantId && b.tenantId) return 1;
    // More headers = more specific
    const aHeaders = a.matchSignature?.headers?.length || 0;
    const bHeaders = b.matchSignature?.headers?.length || 0;
    return bHeaders - aHeaders;
  });
}

/**
 * Invalidate the adapter cache for a tenant (call after creating/updating adapters).
 *
 * @param {string} tenantId
 */
async function invalidateAdapterCache(tenantId) {
  try {
    const redis = getRedisConnection();
    await redis.del(`adapters:${tenantId}`);
    logger.info(`Adapter cache invalidated for tenant ${tenantId}`);
  } catch (err) {
    logger.warn(`Failed to invalidate adapter cache: ${err.message}`);
  }
}

/**
 * Detect which adapter matches the given CSV headers.
 * Uses case-insensitive subset matching — all adapter headers must appear in the CSV.
 *
 * @param {string[]} headers      — CSV column headers
 * @param {Object[]} sampleRows   — First few parsed CSV rows (for preview)
 * @param {string} tenantId
 * @returns {Promise<{matched: boolean, adapter?: Object, confidence?: number, headers?: string[], sampleData?: Object[]}>}
 */
async function detectAdapter(headers, sampleRows, tenantId) {
  const adapters = await getAdaptersForTenant(tenantId);
  const normalizedCsvHeaders = new Set(headers.map((h) => h.trim().toLowerCase()));

  for (const adapter of adapters) {
    const adapterHeaders = adapter.matchSignature?.headers;
    if (!adapterHeaders || !Array.isArray(adapterHeaders)) continue;

    const allMatch = adapterHeaders.every((ah) =>
      normalizedCsvHeaders.has(ah.trim().toLowerCase())
    );

    if (allMatch) {
      const confidence = adapterHeaders.length / headers.length;
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

  // No match found
  return {
    matched: false,
    headers,
    sampleData: sampleRows,
  };
}

// ─── Date Parsing ────────────────────────────────────────────────────────────

/**
 * Parse a date string, optionally using a known format.
 * Returns { date: Date|null, hasTime: boolean }.
 */
function parseDate(dateStr, format) {
  if (!dateStr || typeof dateStr !== 'string') return { date: null, hasTime: false };

  const trimmed = dateStr.trim();
  if (!trimmed) return { date: null, hasTime: false };

  // Check if the raw string contains a time component
  const hasTimeInString = /\d{1,2}:\d{2}/.test(trimmed);

  if (format) {
    const parsed = parseDateWithFormat(trimmed, format);
    if (parsed) {
      return { date: parsed, hasTime: hasTimeInString };
    }
  }

  // Auto-detect: try ISO / JS native first
  const native = new Date(trimmed);
  if (!isNaN(native.getTime())) {
    // When the string has no time component, normalize to UTC midnight.
    // new Date("11/12/2010") parses as local time, shifting the UTC date by ±1 day
    // depending on the server timezone. Force UTC to match the hash computation.
    if (!hasTimeInString) {
      const utcNormalized = new Date(Date.UTC(native.getFullYear(), native.getMonth(), native.getDate()));
      return { date: utcNormalized, hasTime: false };
    }
    return { date: native, hasTime: hasTimeInString };
  }

  // Fallback: try DD/MM/YYYY and variants
  const parts = trimmed.split(/[/\-.]/);
  if (parts.length >= 3) {
    const [p0, p1, p2] = parts;
    let year, month, day;

    if (p2 && p2.length === 2) {
      // Two-digit year
      year = 2000 + parseInt(p2, 10);
    }

    if (p0.length === 4) {
      // YYYY-MM-DD
      year = parseInt(p0, 10);
      month = parseInt(p1, 10) - 1;
      day = parseInt(p2, 10);
    } else if (parseInt(p0, 10) > 12) {
      // DD/MM/YYYY (day > 12 disambiguates)
      day = parseInt(p0, 10);
      month = parseInt(p1, 10) - 1;
      year = year || parseInt(p2, 10);
    } else {
      // Ambiguous — assume DD/MM/YYYY (international)
      day = parseInt(p0, 10);
      month = parseInt(p1, 10) - 1;
      year = year || parseInt(p2, 10);
    }

    const fallback = new Date(Date.UTC(year, month, day));
    if (!isNaN(fallback.getTime())) {
      return { date: fallback, hasTime: false };
    }
  }

  return { date: null, hasTime: false };
}

/**
 * Parse a date string using a known format pattern.
 * Supports: YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY, with optional HH:mm:ss
 */
function parseDateWithFormat(str, format) {
  const hasTime = format.includes('HH') || format.includes('hh');
  const dateTimeParts = str.split(/[\sT]+/);
  const datePart = dateTimeParts[0];
  const timePart = dateTimeParts[1] || null;

  const separators = datePart.match(/[/\-.]/);
  const sep = separators ? separators[0] : '-';
  const parts = datePart.split(sep);

  if (parts.length < 3) return null;

  // Determine order from format
  const formatNorm = format.toUpperCase();
  let year, month, day;

  if (formatNorm.startsWith('YYYY')) {
    year = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10) - 1;
    day = parseInt(parts[2], 10);
  } else if (formatNorm.startsWith('DD')) {
    day = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10) - 1;
    year = parseInt(parts[2], 10);
  } else if (formatNorm.startsWith('MM')) {
    month = parseInt(parts[0], 10) - 1;
    day = parseInt(parts[1], 10);
    year = parseInt(parts[2], 10);
  } else {
    return null;
  }

  // Handle 2-digit year
  if (year < 100) year += 2000;

  let hours = 0, minutes = 0, seconds = 0;
  if (hasTime && timePart) {
    const tp = timePart.split(':');
    hours = parseInt(tp[0], 10) || 0;
    minutes = parseInt(tp[1], 10) || 0;
    seconds = parseInt(tp[2], 10) || 0;
  }

  const date = new Date(Date.UTC(year, month, day, hours, minutes, seconds));
  return isNaN(date.getTime()) ? null : date;
}

// ─── Amount Parsing ──────────────────────────────────────────────────────────

function parseDecimal(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (str === '') return null;
  // Handle comma as decimal separator
  const normalized = str.replace(/,/g, '.');
  const parsed = parseFloat(normalized);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Resolve amount into { debit, credit } based on the adapter's amountStrategy.
 */
function resolveAmount(row, columnMapping, amountStrategy) {
  switch (amountStrategy) {
    case 'SINGLE_SIGNED': {
      const amount = parseDecimal(getColumnValue(row, columnMapping.amount));
      if (amount === null) return { debit: null, credit: null };
      if (amount < 0) return { debit: Math.abs(amount), credit: null };
      if (amount > 0) return { debit: null, credit: amount };
      return { debit: 0, credit: null }; // Zero amount → debit side
    }

    case 'DEBIT_CREDIT_COLUMNS': {
      const debit = parseDecimal(getColumnValue(row, columnMapping.debit));
      const credit = parseDecimal(getColumnValue(row, columnMapping.credit));
      return { debit: debit || null, credit: credit || null };
    }

    case 'SINGLE_SIGNED_INVERTED': {
      // Inverted sign convention (e.g. American Express): positive = expense, negative = payment/refund
      const invAmount = parseDecimal(getColumnValue(row, columnMapping.amount));
      if (invAmount === null) return { debit: null, credit: null };
      if (invAmount > 0) return { debit: invAmount, credit: null };
      if (invAmount < 0) return { debit: null, credit: Math.abs(invAmount) };
      return { debit: 0, credit: null };
    }

    case 'AMOUNT_WITH_TYPE': {
      const amount = parseDecimal(getColumnValue(row, columnMapping.amount));
      const type = (getColumnValue(row, columnMapping.type) || '').toLowerCase().trim();
      if (amount === null) return { debit: null, credit: null };
      const absAmount = Math.abs(amount);
      if (type.includes('debit') || type.includes('expense') || type.includes('payment')) {
        return { debit: absAmount, credit: null };
      }
      if (type.includes('credit') || type.includes('income') || type.includes('deposit')) {
        return { debit: null, credit: absAmount };
      }
      // Fallback: treat as signed
      if (amount < 0) return { debit: Math.abs(amount), credit: null };
      return { debit: null, credit: amount };
    }

    default:
      logger.warn(`Unknown amountStrategy: ${amountStrategy}`);
      return { debit: null, credit: null };
  }
}

// ─── Column Value Extraction ─────────────────────────────────────────────────

/**
 * Get a column value from a row using the mapping.
 * Supports string (single column) or array (concatenation).
 */
function getColumnValue(row, mapping) {
  if (!mapping) return null;

  if (Array.isArray(mapping)) {
    // Concatenate multiple columns
    const parts = mapping
      .map((col) => (row[col] || '').trim())
      .filter((v) => v.length > 0);
    return parts.length > 0 ? parts.join(' - ') : null;
  }

  return row[mapping] !== undefined ? String(row[mapping]).trim() : null;
}

// ─── File Parsing ────────────────────────────────────────────────────────────

/**
 * Parse a CSV or XLSX file buffer using a specific adapter configuration.
 * Returns normalized rows ready for staging.
 *
 * @param {Buffer|string} fileContent — Raw file content
 * @param {Object} adapter            — ImportAdapter record from DB
 * @param {string} [fileType='csv']   — 'csv', 'xlsx', or 'xls'
 * @returns {Promise<{ rows: Array<Object>, hasTimeInDates: boolean }>}
 */
async function parseFile(fileContent, adapter, fileType = 'csv') {
  const { columnMapping, dateFormat, amountStrategy, currencyDefault, skipRows } = adapter;

  let parsedData;

  if (fileType === 'xlsx' || fileType === 'xls') {
    // ── XLSX/XLS parsing via ExcelJS ──
    const buffer = Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    // Use adapter's matchSignature.sheet if specified, otherwise first sheet
    const adapterSheet = adapter.matchSignature?.sheet;
    const worksheet = (adapterSheet && workbook.getWorksheet(adapterSheet))
      ? workbook.getWorksheet(adapterSheet)
      : workbook.worksheets[0];

    if (!worksheet) {
      logger.warn('XLSX: no worksheets found in file');
      return { rows: [], hasTimeInDates: false };
    }
    logger.info(`XLSX: using sheet "${worksheet.name}" (adapter specified: "${adapterSheet || 'none'}")`);

    // Extract headers from first row
    const headerRow = worksheet.getRow(1);
    const headers = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const val = cell.value !== null && cell.value !== undefined ? String(cell.value).trim() : '';
      headers[colNumber - 1] = val;
    });

    // Build row objects, converting cell values to plain JS types
    let rawRows = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header row
      const rowData = {};
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const header = headers[colNumber - 1];
        if (!header) return;
        let value = cell.value;
        // Normalize ExcelJS value types to plain strings/numbers
        if (value !== null && value !== undefined) {
          if (value instanceof Date) {
            // Convert Date objects to ISO string for parseDate()
            value = isNaN(value.getTime()) ? '' : value.toISOString();
          } else if (typeof value === 'object' && value.text !== undefined) {
            value = value.text; // Rich text
          } else if (typeof value === 'object' && value.result !== undefined) {
            value = value.result; // Formula result
          }
        }
        rowData[header] = value !== null && value !== undefined ? value : '';
      });
      rawRows.push(rowData);
    });

    // Handle skipRows (after header)
    if (skipRows > 0) {
      rawRows = rawRows.slice(skipRows);
    }

    parsedData = rawRows;
  } else {
    // ── CSV parsing via PapaParse ──
    const content = Buffer.isBuffer(fileContent) ? fileContent.toString('utf8') : fileContent;

    let csvContent = content;
    if (skipRows > 0) {
      const lines = content.split('\n');
      csvContent = lines.slice(skipRows).join('\n');
    }

    const parsed = Papa.parse(csvContent, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
    });

    if (parsed.errors.length > 0) {
      logger.warn(`PapaParse encountered ${parsed.errors.length} errors during parsing`);
    }

    parsedData = parsed.data;
  }

  let globalHasTime = false;
  const rows = [];

  for (let i = 0; i < parsedData.length; i++) {
    const raw = parsedData[i];

    // Date
    const dateValue = getColumnValue(raw, columnMapping.date);
    const { date, hasTime } = parseDate(dateValue, dateFormat);
    if (hasTime) globalHasTime = true;

    // Description
    const description = getColumnValue(raw, columnMapping.description);

    // Amount
    const { debit, credit } = resolveAmount(raw, columnMapping, amountStrategy);

    // Currency
    const currency = getColumnValue(raw, columnMapping.currency) || currencyDefault || null;

    // Optional: ticker (for investment adapters like eToro)
    // Validate ticker is a meaningful symbol (must contain at least one letter — pure numeric
    // values like "0" are common CSV placeholders for "not applicable" and are not valid tickers).
    const rawTicker = getColumnValue(raw, columnMapping.ticker);
    const ticker = rawTicker && /[a-zA-Z]/.test(String(rawTicker).trim()) ? String(rawTicker).trim() : null;

    // Optional: native-adapter fields (account, category, details, investment data)
    // Non-native adapters that don't define these in columnMapping will receive null — zero behaviour change.
    const account  = getColumnValue(raw, columnMapping.account)   ? String(getColumnValue(raw, columnMapping.account)).trim()   || null : null;
    const category = getColumnValue(raw, columnMapping.category)  ? String(getColumnValue(raw, columnMapping.category)).trim()  || null : null;
    const details  = getColumnValue(raw, columnMapping.details)   ? String(getColumnValue(raw, columnMapping.details)).trim()   || null : null;
    const assetQtyRaw   = getColumnValue(raw, columnMapping.assetQuantity);
    const assetPriceRaw = getColumnValue(raw, columnMapping.assetPrice);
    const assetQuantity = assetQtyRaw   ? (parseFloat(assetQtyRaw)   || null) : null;
    const assetPrice    = assetPriceRaw ? (parseFloat(assetPriceRaw) || null) : null;

    // Optional: tags (comma-separated string in a single CSV cell → string array)
    const rawTagsValue = getColumnValue(raw, columnMapping.tags);
    const tags = rawTagsValue
      ? String(rawTagsValue).split(',').map(t => t.trim()).filter(Boolean)
      : null;

    rows.push({
      date,
      description,
      debit,
      credit,
      currency: currency ? currency.toUpperCase() : null,
      ticker,
      account,
      category,
      details,
      assetQuantity,
      assetPrice,
      tags,
      hasTime,
      rawData: raw,
    });
  }

  logger.info(`Parsed ${rows.length} rows using adapter "${adapter.name}". hasTimeInDates: ${globalHasTime}`);

  return { rows, hasTimeInDates: globalHasTime };
}

module.exports = {
  getAdaptersForTenant,
  invalidateAdapterCache,
  detectAdapter,
  parseFile,
  parseDate,
  parseDecimal,
  sortAdaptersBySpecificity,
};
