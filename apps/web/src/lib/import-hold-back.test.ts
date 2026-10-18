import { describe, it, expect, beforeAll } from 'vitest';
import i18next, { type TFunction } from 'i18next';
import en from '@/i18n/locales/en';
import es from '@/i18n/locales/es';
import { buildCommitToast, holdBackLabels, parseHoldBack } from './import-hold-back';

// Real i18next with the shipped locales, so plurals and interpolation are exercised.
const i18n = i18next.createInstance();
let t: TFunction;
let tEs: TFunction;

beforeAll(async () => {
  await i18n.init({
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    resources: { en: { translation: en }, es: { translation: es } },
  });
  t = i18n.getFixedT('en');
  tEs = i18n.getFixedT('es');
});

describe('parseHoldBack', () => {
  it('parses HELD_BACK codes and ignores staging text', () => {
    expect(parseHoldBack('HELD_BACK:MISSING_QUANTITY,MISSING_PRICE')).toEqual(['MISSING_QUANTITY', 'MISSING_PRICE']);
    expect(parseHoldBack('Could not resolve account from CSV value')).toBeNull();
    expect(parseHoldBack(null)).toBeNull();
    expect(parseHoldBack(undefined)).toBeNull();
    expect(parseHoldBack('HELD_BACK:SOMETHING_NEW,DUPLICATE')).toEqual(['DUPLICATE']);
  });
});

describe('holdBackLabels', () => {
  it('merges missing investment fields into one label', () => {
    expect(holdBackLabels(t, ['MISSING_QUANTITY', 'MISSING_PRICE'])).toEqual(['Missing quantity, price']);
  });

  it('lists the account and other reasons separately', () => {
    expect(holdBackLabels(t, ['MISSING_TICKER', 'MISSING_ACCOUNT'])).toEqual(['Missing ticker', 'Missing account']);
    expect(holdBackLabels(t, ['DUPLICATE'])).toEqual(['Duplicate']);
  });

  it('translates the labels', () => {
    expect(holdBackLabels(tEs, ['MISSING_QUANTITY', 'MISSING_PRICE'])).toEqual(['Falta cantidad, precio']);
    expect(holdBackLabels(tEs, ['MISSING_ACCOUNT'])).toEqual(['Falta la cuenta']);
  });
});

describe('buildCommitToast', () => {
  it('lists counts by reason after a partial commit', () => {
    const toast = buildCommitToast(t, {
      transactionCount: 12,
      updateCount: 0,
      remaining: 25,
      heldBack: { total: 25, byReason: { MISSING_PRICE: 18, MISSING_ACCOUNT: 4, DUPLICATE: 3 } },
    }, 'partial');
    expect(toast).toEqual({
      title: 'Partial commit complete',
      description: '12 created. 25 held back: 18 missing price, 4 missing account, 3 duplicates.',
    });
  });

  it('says "No rows committed" and reports unconfirmed rows as still to review', () => {
    const toast = buildCommitToast(t, {
      transactionCount: 0,
      updateCount: 0,
      remaining: 27,
      heldBack: { total: 25, byReason: { MISSING_QUANTITY: 25, MISSING_PRICE: 25 } },
    }, 'partial');
    expect(toast.description).toBe(
      'No rows committed. 25 held back: 25 missing quantity, 25 missing price. 2 still to review.',
    );
  });

  it('uses singular forms', () => {
    const toast = buildCommitToast(t, {
      transactionCount: 1,
      remaining: 1,
      heldBack: { total: 1, byReason: { DUPLICATE: 1 } },
    }, 'partial');
    expect(toast.description).toBe('1 created. 1 held back: 1 duplicate.');
  });

  it('does not count failed update rows (status ERROR) against remaining', () => {
    const toast = buildCommitToast(t, {
      transactionCount: 0,
      updateCount: 3,
      remaining: 2,
      heldBack: { total: 1, byReason: { UPDATE_FAILED: 1 } },
    }, 'partial');
    expect(toast.description).toBe('3 updated. 1 held back: 1 failed update. 2 still to review.');
  });

  it('renders a pre-#142 payload without heldBack', () => {
    expect(buildCommitToast(t, { transactionCount: 0, updateCount: 0, remaining: 2 }, 'partial').description)
      .toBe('No rows committed. 2 still to review.');
    expect(buildCommitToast(t, { transactionCount: 5, updateCount: 2, remaining: 0 }, 'committed'))
      .toEqual({ title: 'Import committed', description: '5 created, 2 updated.' });
    expect(buildCommitToast(t, null, 'committed').description).toBe('Done.');
  });

  it('translates the toast', () => {
    const toast = buildCommitToast(tEs, {
      transactionCount: 2,
      remaining: 3,
      heldBack: { total: 3, byReason: { DUPLICATE: 3 } },
    }, 'partial');
    expect(toast).toEqual({
      title: 'Confirmación parcial completada',
      description: '2 creadas. 3 retenidas: 3 duplicadas.',
    });
  });
});
