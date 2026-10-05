import { describe, it, expect } from 'vitest';

import en from './locales/en';
import es from './locales/es';
import fr from './locales/fr';
import pt from './locales/pt';
import itLocale from './locales/it';

const LOCALES: Record<string, Record<string, unknown>> = { en, es, fr, pt, it: itLocale };
const NON_EN = ['es', 'fr', 'pt', 'it'] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolve(obj: any, key: string): unknown {
  return key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), obj);
}

// Keys introduced by task #69 (Subscriptions Improvements). Every one must exist,
// be a non-empty string in all five locales, and be translated (not the EN text)
// in es/fr/pt/it.
const NEW_KEYS = [
  'subscriptions.pager.prev',
  'subscriptions.pager.next',
  'subscriptions.pager.pageOf',
  'subscriptions.merge.targetMissing',
  'subscriptions.merge.stale',
  'subscriptions.merge.dismissBlocked',
];

describe('i18n parity — task #69 subscription keys', () => {
  for (const key of NEW_KEYS) {
    it(`"${key}" is a non-empty string in every locale`, () => {
      for (const [lang, dict] of Object.entries(LOCALES)) {
        const v = resolve(dict, key);
        expect(typeof v, `${lang}:${key}`).toBe('string');
        expect((v as string).trim().length, `${lang}:${key}`).toBeGreaterThan(0);
      }
    });

    it(`"${key}" is actually translated in es/fr/pt/it`, () => {
      const enValue = resolve(en, key) as string;
      for (const lang of NON_EN) {
        expect(resolve(LOCALES[lang], key), `${lang}:${key}`).not.toBe(enValue);
      }
    });
  }

  it('pageOf keeps the {{page}} / {{total}} interpolation placeholders in every locale', () => {
    for (const lang of Object.keys(LOCALES)) {
      const v = resolve(LOCALES[lang], 'subscriptions.pager.pageOf') as string;
      expect(v, lang).toContain('{{page}}');
      expect(v, lang).toContain('{{total}}');
    }
  });

  it('nav.subscriptions (used by the Header title) resolves in every locale', () => {
    for (const lang of Object.keys(LOCALES)) {
      const v = resolve(LOCALES[lang], 'nav.subscriptions');
      expect(typeof v, lang).toBe('string');
      expect((v as string).length, lang).toBeGreaterThan(0);
    }
  });
});

// Keys introduced by task #71 (security remediation — identity hygiene).
//
// These are flat, natural-language keys (the convention used throughout the
// auth page), so `resolve` would treat the dots in them as nesting. They are
// looked up directly instead.
const AUTH_ERROR_KEYS = [
  "An account with this email already exists. Sign in with your password instead.",
  "Your Google account's email address is not verified. Verify it with Google, then try again.",
  'Sign-in with Google failed. Please try again.',
  'We could not sign you in automatically. Please try signing in with your password.',
];

describe('i18n parity — task #71 auth rejection messages', () => {
  for (const key of AUTH_ERROR_KEYS) {
    it(`"${key.slice(0, 40)}…" is a non-empty string in every locale`, () => {
      for (const [lang, dict] of Object.entries(LOCALES)) {
        const v = dict[key];
        expect(typeof v, `${lang}`).toBe('string');
        expect((v as string).trim().length, `${lang}`).toBeGreaterThan(0);
      }
    });

    it(`"${key.slice(0, 40)}…" is actually translated in es/fr/pt/it`, () => {
      for (const lang of NON_EN) {
        expect(LOCALES[lang][key], `${lang}`).not.toBe(en[key as keyof typeof en]);
      }
    });
  }
});

// Keys introduced by task #77 (Passive Income Projection). Same rules: present
// and non-empty in all five locales, translated in es/fr/pt/it (except the
// few that are identical by design, e.g. "ETF", "OK", "Total", "Irregular").
const PASSIVE_INCOME_KEYS = [
  'nav.passiveIncome',
  'passiveIncome.title',
  'passiveIncome.subtitle',
  'passiveIncome.kpi.next12m',
  'passiveIncome.kpi.essentialsCoverage',
  'passiveIncome.kpi.dataCoverage',
  'passiveIncome.chart.today',
  'passiveIncome.bucket.other',
  'passiveIncome.status.MATURED_UNREDEEMED',
  'passiveIncome.status.STALE_RATE',
  'passiveIncome.streams.title',
  'passiveIncome.detached.title',
  'passiveIncome.detached.discardConfirm',
  'passiveIncome.missing.title_one',
  'passiveIncome.missing.title_other',
  'incomeTerms.action',
  'incomeTerms.override',
  'incomeTerms.notDistributing',
  'incomeTerms.fields.faceValuePerUnit',
  'incomeTerms.fields.monthlyRent',
  'incomeTerms.errors.required',
  'maintenance.securityData.title',
  'maintenance.securityData.button',
  'maintenance.globalFundamentals.title',
  'maintenance.fullRebuildSecuritiesStep',
  'equityAnalysis.diversified',
];

// Keys introduced by task #83 (group holdings by symbol, cash by currency).
const PASSIVE_INCOME_GROUP_KEYS = [
  'passiveIncome.source.MIXED',
  'passiveIncome.frequency.MIXED',
  'passiveIncome.breakdown.mixed',
  'passiveIncome.breakdown.accounts_one',
  'passiveIncome.breakdown.accounts_other',
  'passiveIncome.breakdown.showAccounts_one',
  'passiveIncome.breakdown.showAccounts_other',
  'passiveIncome.breakdown.hideAccounts',
  'passiveIncome.breakdown.editGroup',
  'passiveIncome.breakdown.cashSummary',
  'passiveIncome.breakdown.quantity',
  'passiveIncome.breakdown.view.label',
  'passiveIncome.breakdown.view.grouped',
  'passiveIncome.breakdown.view.flat',
  'incomeTerms.groupTitle_one',
  'incomeTerms.groupTitle_other',
  'incomeTerms.applyToAllHoldings_one',
  'incomeTerms.applyToAllHoldings_other',
  'incomeTerms.appliesToHoldings_one',
  'incomeTerms.appliesToHoldings_other',
  'incomeTerms.mixedTitle',
  'incomeTerms.mixedDescription',
  'incomeTerms.mixedAccount',
  'incomeTerms.mixedUseSame',
  'incomeTerms.mixedEditOne',
  'incomeTerms.removeFromAllConfirm_one',
  'incomeTerms.removeFromAllConfirm_other',
  'incomeTerms.faceValuePerUnitGroupHint_one',
  'incomeTerms.faceValuePerUnitGroupHint_other',
];

const FREQUENCY_KEYS = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'AT_MATURITY', 'IRREGULAR', 'NONE']
  .map((f) => `passiveIncome.frequency.${f}`);
const INCOME_TYPE_KEYS = ['DIVIDEND', 'FIXED_COUPON', 'FLOATING_COUPON', 'INFLATION_LINKED', 'RENT', 'INTEREST', 'CUSTOM_YIELD', 'FIXED_AMOUNT', 'NONE']
  .map((ty) => `passiveIncome.incomeType.${ty}`);

describe('i18n parity — task #77 passive income keys', () => {
  for (const key of [...PASSIVE_INCOME_KEYS, ...FREQUENCY_KEYS, ...INCOME_TYPE_KEYS]) {
    it(`"${key}" is a non-empty string in every locale`, () => {
      for (const [lang, dict] of Object.entries(LOCALES)) {
        const v = resolve(dict, key);
        expect(typeof v, `${lang}:${key}`).toBe('string');
        expect((v as string).trim().length, `${lang}:${key}`).toBeGreaterThan(0);
      }
    });
  }

  for (const key of PASSIVE_INCOME_KEYS) {
    it(`"${key}" is actually translated in es/fr/pt/it`, () => {
      const enValue = resolve(en, key) as string;
      for (const lang of NON_EN) {
        expect(resolve(LOCALES[lang], key), `${lang}:${key}`).not.toBe(enValue);
      }
    });
  }
});

describe('i18n parity — task #83 grouped passive income keys', () => {
  for (const key of PASSIVE_INCOME_GROUP_KEYS) {
    it(`"${key}" is a non-empty, translated string in every locale`, () => {
      const enValue = resolve(en, key) as string;
      for (const [lang, dict] of Object.entries(LOCALES)) {
        const v = resolve(dict, key);
        expect(typeof v, `${lang}:${key}`).toBe('string');
        expect((v as string).trim().length, `${lang}:${key}`).toBeGreaterThan(0);
        if (lang !== 'en') expect(v, `${lang}:${key}`).not.toBe(enValue);
      }
    });
  }
});

// Keys introduced by task #81 (Manage Assets). Present and non-empty in every
// locale, and translated in es/fr/pt/it (except where the word is the same,
// e.g. "Type" in French).
const MANAGE_ASSETS_KEYS = [
  'nav.manageAssets',
  'manageAssets.title',
  'manageAssets.subtitle',
  'manageAssets.loadFailed',
  'manageAssets.assetClassHint',
  'manageAssets.searchPlaceholder',
  'manageAssets.empty',
  'manageAssets.count_one',
  'manageAssets.count_other',
  'manageAssets.loadMore',
  'manageAssets.loadingMore',
  'manageAssets.columns.assetClass',
  'manageAssets.filters.type',
  'manageAssets.filters.allTypes',
  'manageAssets.filters.account',
  'manageAssets.filters.allAccounts',
  'manageAssets.filters.assetClass',
  'manageAssets.filters.allAssetClasses',
  'manageAssets.filters.includeClosed',
  'manageAssets.filters.clear',
  'manageAssets.status.label',
  'manageAssets.status.stale',
  'manageAssets.status.incomeMissing',
  'manageAssets.status.dividendOverride',
  'manageAssets.status.lotMismatch',
  'manageAssets.status.assetClassOverridden',
  'manageAssets.chips.noPrice',
  'manageAssets.actions.menu',
  'manageAssets.actions.price',
  'manageAssets.actions.history',
  'manageAssets.actions.assetClass',
  'manageAssets.detached.title_one',
  'manageAssets.detached.title_other',
  'manageAssets.detached.description',
  'manageAssets.detached.review',
  'manageAssets.detached.hide',
  'manageAssets.status.debtTermsMissing',
  'manageAssets.actions.addIncomeTerms',
  'manageAssets.actions.addDebtTerms',
  'manageAssets.attention.title_one',
  'manageAssets.attention.title_other',
  'manageAssets.attention.allClear',
  'manageAssets.attention.allClearHint',
  'manageAssets.attention.stale',
  'manageAssets.attention.debtTermsMissing',
  'manageAssets.attention.incomeMissing',
  'manageAssets.attention.lotMismatch',
  'manageAssets.sort.label',
  'manageAssets.sort.attention',
  'manageAssets.sort.name',
];

const SAME_IN_SOME_LOCALES = new Set([
  'manageAssets.filters.type',
  'manageAssets.count_one',
  'manageAssets.count_other',
  'manageAssets.sort.name', // "A–Z" everywhere
]);

describe('i18n parity — task #81 Manage Assets keys', () => {
  for (const key of MANAGE_ASSETS_KEYS) {
    it(`"${key}" is a non-empty string in every locale`, () => {
      for (const [lang, dict] of Object.entries(LOCALES)) {
        const v = resolve(dict, key);
        expect(typeof v, `${lang}:${key}`).toBe('string');
        expect((v as string).trim().length, `${lang}:${key}`).toBeGreaterThan(0);
      }
    });
  }

  it('is translated in es/fr/pt/it', () => {
    for (const key of MANAGE_ASSETS_KEYS.filter((k) => !SAME_IN_SOME_LOCALES.has(k))) {
      const enValue = resolve(en, key) as string;
      for (const lang of NON_EN) {
        expect(resolve(LOCALES[lang], key), `${lang}:${key}`).not.toBe(enValue);
      }
    }
  });

  it('keeps interpolation placeholders', () => {
    for (const lang of Object.keys(LOCALES)) {
      expect(resolve(LOCALES[lang], 'manageAssets.actions.menu'), lang).toContain('{{symbol}}');
      expect(resolve(LOCALES[lang], 'manageAssets.assetClassHint'), lang).toContain('{{symbol}}');
      expect(resolve(LOCALES[lang], 'manageAssets.count_other'), lang).toContain('{{count}}');
      expect(resolve(LOCALES[lang], 'manageAssets.detached.title_other'), lang).toContain('{{count}}');
      expect(resolve(LOCALES[lang], 'manageAssets.attention.title_one'), lang).toContain('{{count}}');
      expect(resolve(LOCALES[lang], 'manageAssets.attention.title_other'), lang).toContain('{{count}}');
    }
  });

  it('the old nav.assetPriceUpdates key is gone', () => {
    for (const lang of Object.keys(LOCALES)) expect(resolve(LOCALES[lang], 'nav.assetPriceUpdates'), lang).toBeUndefined();
  });
});

// Keys introduced by task #84 (Integrations & API tokens). Every leaf under
// pages.settings.integrations in EN must exist in every locale, keep its
// interpolation placeholders, and be translated.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function leafKeys(obj: any, prefix: string): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? leafKeys(v, `${prefix}.${k}`) : [`${prefix}.${k}`],
  );
}

// Values that are legitimately identical in some languages.
const SAME_AS_EN_ALLOWED = new Set([
  'pages.settings.integrations.form.name_label',
  'pages.settings.integrations.status_active',
  'pages.settings.integrations.form.description_label',
  'pages.settings.tabs.maintenance', // "Maintenance" in French too
  'pages.settings.tabs.admin_section', // "Administration" in French too
]);

describe('i18n parity — task #84 integrations keys', () => {
  const keys = [
    ...leafKeys(resolve(en, 'pages.settings.integrations'), 'pages.settings.integrations'),
    'pages.settings.tabs.integrations',
    'pages.settings.tabs.ai_classification',
    'pages.settings.tabs.maintenance',
    'pages.settings.tabs.admin_section',
  ];

  it('has a meaningful number of keys', () => {
    expect(keys.length).toBeGreaterThan(50);
  });

  for (const key of keys) {
    it(`"${key}" exists in every locale with the same placeholders`, () => {
      const enValue = resolve(en, key) as string;
      const placeholders = (enValue.match(/\{\{\w+\}\}/g) ?? []).sort();
      for (const [lang, dict] of Object.entries(LOCALES)) {
        const v = resolve(dict, key);
        expect(typeof v, `${lang}:${key}`).toBe('string');
        expect((v as string).trim().length, `${lang}:${key}`).toBeGreaterThan(0);
        expect(((v as string).match(/\{\{\w+\}\}/g) ?? []).sort(), `${lang}:${key}`).toEqual(placeholders);
      }
    });
  }

  it('is translated in es/fr/pt/it', () => {
    const untranslated: string[] = [];
    for (const key of keys) {
      if (SAME_AS_EN_ALLOWED.has(key)) continue;
      for (const lang of NON_EN) {
        if (resolve(LOCALES[lang], key) === resolve(en, key)) untranslated.push(`${lang}:${key}`);
      }
    }
    expect(untranslated).toEqual([]);
  });
});

// ── Processing status (#100, AC14) ───────────────────────────────────────────
// Every `activity.*` key exists as a non-empty string in all five locales,
// keeps its {{placeholders}}, and the Settings tab label resolves everywhere.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function leaves(obj: any, prefix = ''): Array<[string, unknown]> {
  return Object.entries(obj ?? {}).flatMap(([k, v]) =>
    v !== null && typeof v === 'object' ? leaves(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v] as [string, unknown]]);
}

describe('i18n parity — processing status (#100)', () => {
  const enLeaves = leaves(resolve(en, 'activity'));

  it('has a meaningful number of keys', () => {
    expect(enLeaves.length).toBeGreaterThan(60);
  });

  for (const lang of NON_EN) {
    it(`${lang} has exactly the English activity.* keys, all non-empty, placeholders intact`, () => {
      const other = new Map(leaves(resolve(LOCALES[lang], 'activity')));
      expect([...other.keys()].sort()).toEqual(enLeaves.map(([k]) => k).sort());
      for (const [key, enValue] of enLeaves) {
        const v = other.get(key);
        expect(typeof v, `${lang}:activity.${key}`).toBe('string');
        expect((v as string).trim().length, `${lang}:activity.${key}`).toBeGreaterThan(0);
        const placeholders = (s: string) => (s.match(/{{\w+}}/g) ?? []).sort();
        expect(placeholders(v as string), `${lang}:activity.${key}`).toEqual(placeholders(enValue as string));
      }
    });
  }

  it('the Processing settings tab label resolves in every locale', () => {
    for (const lang of Object.keys(LOCALES)) {
      expect(typeof resolve(LOCALES[lang], 'pages.settings.tabs.processing'), lang).toBe('string');
    }
  });
});
