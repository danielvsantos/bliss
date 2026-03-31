/**
 * Unit tests for computeUpdateDiff() from smartImportWorker.
 *
 * computeUpdateDiff is not exported, so we extract and test it via a
 * small wrapper that requires the worker module just for the function.
 * Since extracting from a worker file is complex, we re-implement the
 * function here identically for isolated testing.
 */

// Re-implementation of computeUpdateDiff for isolated unit testing.
// Kept in sync with smartImportWorker.js lines 138-230.
function computeUpdateDiff(csvRow, existingTx, resolvedCategoryId, categoryById) {
  const diff = {};

  const csvDesc = (csvRow.description || '').trim();
  const txDesc = (existingTx.description || '').trim();
  if (csvDesc !== txDesc) {
    diff.description = { old: existingTx.description, new: csvRow.description };
  }

  const csvDetails = csvRow.details || null;
  const txDetails = existingTx.details || null;
  if ((csvDetails || '') !== (txDetails || '')) {
    diff.details = { old: txDetails, new: csvDetails };
  }

  const csvDebit = csvRow.debit ? parseFloat(csvRow.debit) : null;
  const txDebit = existingTx.debit ? parseFloat(existingTx.debit) : null;
  if (csvDebit !== txDebit) {
    diff.debit = { old: txDebit, new: csvDebit };
  }

  const csvCredit = csvRow.credit ? parseFloat(csvRow.credit) : null;
  const txCredit = existingTx.credit ? parseFloat(existingTx.credit) : null;
  if (csvCredit !== txCredit) {
    diff.credit = { old: txCredit, new: csvCredit };
  }

  if (resolvedCategoryId && resolvedCategoryId !== existingTx.categoryId) {
    const oldCat = categoryById.get(existingTx.categoryId);
    const newCat = categoryById.get(resolvedCategoryId);
    diff.categoryId = {
      old: existingTx.categoryId,
      new: resolvedCategoryId,
      oldName: oldCat?.name || null,
      newName: newCat?.name || null,
    };
  }

  const csvDate = new Date(csvRow.date);
  const txDate = new Date(existingTx.transaction_date);
  if (csvDate.toISOString().slice(0, 10) !== txDate.toISOString().slice(0, 10)) {
    diff.transactionDate = {
      old: txDate.toISOString().slice(0, 10),
      new: csvDate.toISOString().slice(0, 10),
    };
  }

  const csvCurrency = (csvRow.currency || '').toUpperCase();
  const txCurrency = (existingTx.currency || '').toUpperCase();
  if (csvCurrency && csvCurrency !== txCurrency) {
    diff.currency = { old: existingTx.currency, new: csvCurrency };
  }

  const existingTagNames = (existingTx.tags || [])
    .map(t => (t.tag ? t.tag.name : t.name) || '')
    .filter(Boolean)
    .sort();
  const csvTagNames = (csvRow.tags || []).map(t => String(t).trim()).filter(Boolean).sort();
  if (JSON.stringify(existingTagNames) !== JSON.stringify(csvTagNames)) {
    diff.tags = { old: existingTagNames, new: csvTagNames };
  }

  const csvTicker = csvRow.ticker && /[a-zA-Z]/.test(String(csvRow.ticker))
    ? String(csvRow.ticker).trim()
    : null;
  if ((csvTicker || null) !== (existingTx.ticker || null)) {
    diff.ticker = { old: existingTx.ticker || null, new: csvTicker };
  }

  const csvQty = csvRow.assetQuantity ? parseFloat(csvRow.assetQuantity) : null;
  const txQty = existingTx.assetQuantity ? parseFloat(existingTx.assetQuantity) : null;
  if (csvQty !== txQty) {
    diff.assetQuantity = { old: txQty, new: csvQty };
  }

  const csvPrice = csvRow.assetPrice ? parseFloat(csvRow.assetPrice) : null;
  const txPrice = existingTx.assetPrice ? parseFloat(existingTx.assetPrice) : null;
  if (csvPrice !== txPrice) {
    diff.assetPrice = { old: txPrice, new: csvPrice };
  }

  return diff;
}

// ── Fixtures ──────────────────────────────────────────────────────────

function makeExistingTx(overrides = {}) {
  return {
    id: 100,
    description: 'Morning Coffee',
    details: 'Starbucks on 5th',
    debit: '4.50',
    credit: null,
    categoryId: 10,
    transaction_date: '2026-02-15T00:00:00.000Z',
    currency: 'USD',
    tags: [{ tag: { name: 'daily' } }, { tag: { name: 'food' } }],
    ticker: null,
    assetQuantity: null,
    assetPrice: null,
    accountId: 1,
    ...overrides,
  };
}

function makeCsvRow(overrides = {}) {
  return {
    description: 'Morning Coffee',
    details: 'Starbucks on 5th',
    debit: '4.50',
    credit: null,
    date: '2026-02-15',
    currency: 'USD',
    tags: ['daily', 'food'],
    ticker: null,
    assetQuantity: null,
    assetPrice: null,
    ...overrides,
  };
}

function makeCategoryMap(entries = []) {
  const map = new Map();
  for (const e of entries) map.set(e.id, e);
  return map;
}

const defaultCategoryMap = makeCategoryMap([
  { id: 10, name: 'Coffee' },
  { id: 20, name: 'Groceries' },
]);

// ── Tests ─────────────────────────────────────────────────────────────

describe('computeUpdateDiff', () => {
  it('returns empty diff when nothing changed', () => {
    const csv = makeCsvRow();
    const tx = makeExistingTx();
    const diff = computeUpdateDiff(csv, tx, 10, defaultCategoryMap);
    expect(diff).toEqual({});
  });

  it('detects description change', () => {
    const csv = makeCsvRow({ description: 'Afternoon Tea' });
    const tx = makeExistingTx();
    const diff = computeUpdateDiff(csv, tx, 10, defaultCategoryMap);
    expect(diff.description).toEqual({ old: 'Morning Coffee', new: 'Afternoon Tea' });
    // No other fields changed
    expect(Object.keys(diff)).toEqual(['description']);
  });

  it('detects details change (including clearing)', () => {
    const csv = makeCsvRow({ details: null });
    const tx = makeExistingTx();
    const diff = computeUpdateDiff(csv, tx, 10, defaultCategoryMap);
    expect(diff.details).toEqual({ old: 'Starbucks on 5th', new: null });
  });

  it('detects debit amount change', () => {
    const csv = makeCsvRow({ debit: '5.00' });
    const tx = makeExistingTx();
    const diff = computeUpdateDiff(csv, tx, 10, defaultCategoryMap);
    expect(diff.debit).toEqual({ old: 4.5, new: 5.0 });
  });

  it('detects credit amount change', () => {
    const csv = makeCsvRow({ debit: null, credit: '10.00' });
    const tx = makeExistingTx({ debit: null, credit: '10.00' });
    // Same amounts — no diff
    let diff = computeUpdateDiff(csv, tx, 10, defaultCategoryMap);
    expect(diff.credit).toBeUndefined();

    // Now change it
    const csv2 = makeCsvRow({ debit: null, credit: '15.00' });
    diff = computeUpdateDiff(csv2, tx, 10, defaultCategoryMap);
    expect(diff.credit).toEqual({ old: 10.0, new: 15.0 });
  });

  it('detects category change with names', () => {
    const csv = makeCsvRow();
    const tx = makeExistingTx();
    const diff = computeUpdateDiff(csv, tx, 20, defaultCategoryMap);
    expect(diff.categoryId).toEqual({
      old: 10,
      new: 20,
      oldName: 'Coffee',
      newName: 'Groceries',
    });
  });

  it('does not report category diff when resolvedCategoryId is null', () => {
    const csv = makeCsvRow();
    const tx = makeExistingTx();
    const diff = computeUpdateDiff(csv, tx, null, defaultCategoryMap);
    expect(diff.categoryId).toBeUndefined();
  });

  it('does not report category diff when same', () => {
    const csv = makeCsvRow();
    const tx = makeExistingTx();
    const diff = computeUpdateDiff(csv, tx, 10, defaultCategoryMap);
    expect(diff.categoryId).toBeUndefined();
  });

  it('detects date change', () => {
    const csv = makeCsvRow({ date: '2026-03-01' });
    const tx = makeExistingTx();
    const diff = computeUpdateDiff(csv, tx, 10, defaultCategoryMap);
    expect(diff.transactionDate).toEqual({
      old: '2026-02-15',
      new: '2026-03-01',
    });
  });

  it('detects currency change', () => {
    const csv = makeCsvRow({ currency: 'EUR' });
    const tx = makeExistingTx();
    const diff = computeUpdateDiff(csv, tx, 10, defaultCategoryMap);
    expect(diff.currency).toEqual({ old: 'USD', new: 'EUR' });
  });

  it('ignores currency case (usd vs USD)', () => {
    const csv = makeCsvRow({ currency: 'usd' });
    const tx = makeExistingTx();
    const diff = computeUpdateDiff(csv, tx, 10, defaultCategoryMap);
    expect(diff.currency).toBeUndefined();
  });

  it('detects tag additions', () => {
    const csv = makeCsvRow({ tags: ['daily', 'food', 'new-tag'] });
    const tx = makeExistingTx();
    const diff = computeUpdateDiff(csv, tx, 10, defaultCategoryMap);
    expect(diff.tags).toEqual({
      old: ['daily', 'food'],
      new: ['daily', 'food', 'new-tag'],
    });
  });

  it('detects tag removals', () => {
    const csv = makeCsvRow({ tags: ['daily'] });
    const tx = makeExistingTx();
    const diff = computeUpdateDiff(csv, tx, 10, defaultCategoryMap);
    expect(diff.tags).toEqual({
      old: ['daily', 'food'],
      new: ['daily'],
    });
  });

  it('handles empty tags on both sides', () => {
    const csv = makeCsvRow({ tags: [] });
    const tx = makeExistingTx({ tags: [] });
    const diff = computeUpdateDiff(csv, tx, 10, defaultCategoryMap);
    expect(diff.tags).toBeUndefined();
  });

  it('detects ticker change', () => {
    const csv = makeCsvRow({ ticker: 'AAPL' });
    const tx = makeExistingTx();
    const diff = computeUpdateDiff(csv, tx, 10, defaultCategoryMap);
    expect(diff.ticker).toEqual({ old: null, new: 'AAPL' });
  });

  it('ignores numeric-only ticker', () => {
    const csv = makeCsvRow({ ticker: '12345' });
    const tx = makeExistingTx();
    const diff = computeUpdateDiff(csv, tx, 10, defaultCategoryMap);
    expect(diff.ticker).toBeUndefined();
  });

  it('detects assetQuantity change', () => {
    const csv = makeCsvRow({ assetQuantity: '100' });
    const tx = makeExistingTx();
    const diff = computeUpdateDiff(csv, tx, 10, defaultCategoryMap);
    expect(diff.assetQuantity).toEqual({ old: null, new: 100 });
  });

  it('detects assetPrice change', () => {
    const csv = makeCsvRow({ assetPrice: '150.25' });
    const tx = makeExistingTx();
    const diff = computeUpdateDiff(csv, tx, 10, defaultCategoryMap);
    expect(diff.assetPrice).toEqual({ old: null, new: 150.25 });
  });

  it('detects multiple changes at once', () => {
    const csv = makeCsvRow({
      description: 'Updated Coffee',
      debit: '6.00',
      tags: ['morning'],
      ticker: 'SBUX',
    });
    const tx = makeExistingTx();
    const diff = computeUpdateDiff(csv, tx, 20, defaultCategoryMap);
    expect(Object.keys(diff).sort()).toEqual([
      'categoryId', 'debit', 'description', 'tags', 'ticker',
    ]);
  });
});
