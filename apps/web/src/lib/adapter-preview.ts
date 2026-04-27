/**
 * adapter-preview.ts
 *
 * Frontend replication of the essential parsing logic from
 * apps/backend/src/services/adapterEngine.js — used only for the
 * live-preview row in the adapter create/edit form.
 *
 * IMPORTANT: Keep in sync with adapterEngine.js. If you change date
 * parsing or amount-strategy logic there, mirror the change here.
 */

export type AmountStrategy =
  | 'SINGLE_SIGNED'
  | 'SINGLE_SIGNED_INVERTED'
  | 'DEBIT_CREDIT_COLUMNS'
  | 'AMOUNT_WITH_TYPE';

export type PreviewResult = {
  date: string | null;
  description: string | null;
  amount: number | null;
  amountType: 'debit' | 'credit' | null;
  currency: string | null;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseDecimal(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (str === '') return null;
  // Normalise comma-as-decimal (e.g. European CSV exports)
  const normalized = str.replace(/,/g, '.');
  const parsed = parseFloat(normalized);
  return isNaN(parsed) ? null : parsed;
}

function getColumnValue(
  row: Record<string, unknown>,
  mapping: string | string[] | undefined | null,
): string | null {
  if (!mapping) return null;
  if (Array.isArray(mapping)) {
    const parts = mapping
      .map((col) => String(row[col] ?? '').trim())
      .filter((v) => v.length > 0);
    return parts.length > 0 ? parts.join(' - ') : null;
  }
  return row[mapping] !== undefined ? String(row[mapping]).trim() : null;
}

function parseDateWithFormat(str: string, format: string): Date | null {
  const hasTime = format.includes('HH') || format.includes('hh');
  const dateTimeParts = str.split(/[\sT]+/);
  const datePart = dateTimeParts[0];
  const timePart = dateTimeParts[1] || null;

  const separators = datePart.match(/[/\-.]/);
  const sep = separators ? separators[0] : '-';
  const parts = datePart.split(sep);

  if (parts.length < 3) return null;

  const formatNorm = format.toUpperCase();
  let year: number, month: number, day: number;

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

function parseDate(dateStr: unknown, format?: string): Date | null {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const trimmed = dateStr.trim();
  if (!trimmed) return null;

  if (format) {
    const parsed = parseDateWithFormat(trimmed, format);
    if (parsed) return parsed;
  }

  const hasTimeInString = /\d{1,2}:\d{2}/.test(trimmed);
  const native = new Date(trimmed);
  if (!isNaN(native.getTime())) {
    if (!hasTimeInString) {
      return new Date(Date.UTC(native.getFullYear(), native.getMonth(), native.getDate()));
    }
    return native;
  }

  // Fallback: try common European separators
  const parts = trimmed.split(/[/\-.]/);
  if (parts.length >= 3) {
    const [p0, p1, p2] = parts;
    let year: number | undefined;
    let month: number;
    let day: number;

    if (p2 && p2.length === 2) {
      year = 2000 + parseInt(p2, 10);
    }

    if (p0.length === 4) {
      year = parseInt(p0, 10);
      month = parseInt(p1, 10) - 1;
      day = parseInt(p2, 10);
    } else if (parseInt(p0, 10) > 12) {
      day = parseInt(p0, 10);
      month = parseInt(p1, 10) - 1;
      year = year ?? parseInt(p2, 10);
    } else {
      day = parseInt(p0, 10);
      month = parseInt(p1, 10) - 1;
      year = year ?? parseInt(p2, 10);
    }

    const fallback = new Date(Date.UTC(year!, month!, day!));
    if (!isNaN(fallback.getTime())) return fallback;
  }

  return null;
}

function resolveAmount(
  row: Record<string, unknown>,
  columnMapping: Record<string, string | string[] | undefined>,
  amountStrategy: AmountStrategy,
): { debit: number | null; credit: number | null } {
  switch (amountStrategy) {
    case 'SINGLE_SIGNED': {
      const amount = parseDecimal(getColumnValue(row, columnMapping.amount));
      if (amount === null) return { debit: null, credit: null };
      if (amount < 0) return { debit: Math.abs(amount), credit: null };
      if (amount > 0) return { debit: null, credit: amount };
      return { debit: 0, credit: null };
    }
    case 'DEBIT_CREDIT_COLUMNS': {
      const debit = parseDecimal(getColumnValue(row, columnMapping.debit));
      const credit = parseDecimal(getColumnValue(row, columnMapping.credit));
      return { debit: debit || null, credit: credit || null };
    }
    case 'SINGLE_SIGNED_INVERTED': {
      // Inverted sign (e.g. Amex): positive = expense, negative = refund
      const inv = parseDecimal(getColumnValue(row, columnMapping.amount));
      if (inv === null) return { debit: null, credit: null };
      if (inv > 0) return { debit: inv, credit: null };
      if (inv < 0) return { debit: null, credit: Math.abs(inv) };
      return { debit: 0, credit: null };
    }
    case 'AMOUNT_WITH_TYPE': {
      const amount = parseDecimal(getColumnValue(row, columnMapping.amount));
      const type = (getColumnValue(row, columnMapping.type) ?? '').toLowerCase().trim();
      if (amount === null) return { debit: null, credit: null };
      const abs = Math.abs(amount);
      if (type.includes('debit') || type.includes('expense') || type.includes('payment'))
        return { debit: abs, credit: null };
      if (type.includes('credit') || type.includes('income') || type.includes('deposit'))
        return { debit: null, credit: abs };
      if (amount < 0) return { debit: Math.abs(amount), credit: null };
      return { debit: null, credit: amount };
    }
    default:
      return { debit: null, credit: null };
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Given a raw CSV row and adapter configuration, return a human-readable
 * preview of how the row will be parsed into a Bliss transaction.
 */
export function previewRow(
  row: Record<string, unknown>,
  columnMapping: Record<string, string | string[] | undefined>,
  amountStrategy: AmountStrategy,
  dateFormat: string | undefined,
  currencyDefault: string | undefined,
): PreviewResult {
  const dateRaw = getColumnValue(row, columnMapping.date);
  const date = dateRaw ? parseDate(dateRaw, dateFormat || undefined) : null;

  const description = getColumnValue(row, columnMapping.description);

  const { debit, credit } = resolveAmount(row, columnMapping, amountStrategy);

  const currencyCol = getColumnValue(row, columnMapping.currency);
  const currency = currencyDefault || currencyCol || null;

  let amount: number | null = null;
  let amountType: 'debit' | 'credit' | null = null;
  if (debit !== null) {
    amount = debit;
    amountType = 'debit';
  } else if (credit !== null) {
    amount = credit;
    amountType = 'credit';
  }

  return {
    date: date ? date.toISOString().split('T')[0] : null,
    description,
    amount,
    amountType,
    currency,
  };
}
