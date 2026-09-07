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
