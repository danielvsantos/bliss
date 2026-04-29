import { describe, it, expect } from 'vitest';
import { inferDateFormat, previewRow } from './adapter-preview';
import type { AmountStrategy } from './adapter-preview';

// ─── inferDateFormat ───────────────────────────────────────────────────────────

describe('inferDateFormat()', () => {
  it('returns DD/MM/YYYY when the first part exceeds 12', () => {
    expect(inferDateFormat(['15/01/2024', '20/02/2024'])).toBe('DD/MM/YYYY');
  });

  it('returns MM/DD/YYYY when the second part exceeds 12', () => {
    expect(inferDateFormat(['01/15/2024', '02/20/2024'])).toBe('MM/DD/YYYY');
  });

  it('returns null when all values are ≤ 12 (genuinely ambiguous)', () => {
    expect(inferDateFormat(['01/12/2024', '03/08/2024'])).toBeNull();
  });

  it('ignores YYYY-first entries and continues scanning', () => {
    expect(inferDateFormat(['2024-01-15', '20/01/2024'])).toBe('DD/MM/YYYY');
  });

  it('returns null for an empty array', () => {
    expect(inferDateFormat([])).toBeNull();
  });

  it('skips falsy entries', () => {
    expect(inferDateFormat([null as unknown as string, '', '25/01/2024'])).toBe('DD/MM/YYYY');
  });

  it('works with datetime strings — strips time before classifying', () => {
    expect(inferDateFormat(['20/01/2024 09:45:00', '25/02/2024 14:00:00'])).toBe('DD/MM/YYYY');
  });
});

// ─── previewRow ────────────────────────────────────────────────────────────────

const baseRow: Record<string, unknown> = {
  Date: '2024-03-15',
  Description: 'Starbucks',
  Amount: '-4.85',
  Category: 'Food & Drink',
};

const baseColMap = {
  date: 'Date',
  description: 'Description',
  amount: 'Amount',
  category: 'Category',
};

describe('previewRow()', () => {
  it('parses a basic SINGLE_SIGNED row', () => {
    const result = previewRow(baseRow, baseColMap, 'SINGLE_SIGNED', undefined, 'USD');
    expect(result.date).toBe('2024-03-15');
    expect(result.description).toBe('Starbucks');
    expect(result.amount).toBe(4.85);
    expect(result.amountType).toBe('debit');
    expect(result.currency).toBe('USD');
  });

  it('returns externalCategory from the category column', () => {
    const result = previewRow(baseRow, baseColMap, 'SINGLE_SIGNED', undefined, 'USD');
    expect(result.externalCategory).toBe('Food & Drink');
  });

  it('returns null externalCategory when no category column is mapped', () => {
    const colMapNoCategory = { date: 'Date', description: 'Description', amount: 'Amount' };
    const result = previewRow(baseRow, colMapNoCategory, 'SINGLE_SIGNED', undefined, 'USD');
    expect(result.externalCategory).toBeNull();
  });

  it('parses a datetime string without corrupting the date', () => {
    const rowWithDatetime = { ...baseRow, Date: '15/01/2024 09:45:23' };
    const result = previewRow(rowWithDatetime, baseColMap, 'SINGLE_SIGNED', 'DD/MM/YYYY', 'EUR');
    expect(result.date).toBe('2024-01-15');
  });

  it('returns credit for a positive SINGLE_SIGNED amount', () => {
    const creditRow = { ...baseRow, Amount: '1500.00' };
    const result = previewRow(creditRow, baseColMap, 'SINGLE_SIGNED' as AmountStrategy, undefined, 'USD');
    expect(result.amountType).toBe('credit');
    expect(result.amount).toBe(1500);
  });

  it('SINGLE_SIGNED_INVERTED: positive amount → debit', () => {
    const row = { ...baseRow, Amount: '45.20' };
    const result = previewRow(row, baseColMap, 'SINGLE_SIGNED_INVERTED', undefined, 'USD');
    expect(result.amountType).toBe('debit');
    expect(result.amount).toBe(45.20);
  });

  it('DEBIT_CREDIT_COLUMNS: picks the debit column', () => {
    const row = { Date: '2024-01-10', Description: 'Rent', Debit: '1200.00', Credit: '' };
    const colMap = { date: 'Date', description: 'Description', debit: 'Debit', credit: 'Credit' };
    const result = previewRow(row, colMap, 'DEBIT_CREDIT_COLUMNS', undefined, 'USD');
    expect(result.amountType).toBe('debit');
    expect(result.amount).toBe(1200);
  });
});
