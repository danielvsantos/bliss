import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';

import en from '@/i18n/locales/en';
import es from '@/i18n/locales/es';
import fr from '@/i18n/locales/fr';
import pt from '@/i18n/locales/pt';
import itLocale from '@/i18n/locales/it';

const LOCALES: Record<string, Record<string, unknown>> = { en, es, fr, pt, it: itLocale };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolve(obj: any, key: string): unknown {
  return key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), obj);
}

let currentLang = 'en';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const v = resolve(LOCALES[currentLang], key) ?? resolve(LOCALES.en, key);
      return typeof v === 'string' ? v : key;
    },
    i18n: { language: currentLang, changeLanguage: (l: string) => { currentLang = l; } },
  }),
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ signOut: vi.fn(), user: { name: 'Ada Lovelace', email: 'ada@example.com' } }),
}));
vi.mock('@/components/notification-center', () => ({ NotificationCenter: () => <div /> }));
vi.mock('@/components/language-switcher', () => ({ LanguageSwitcher: () => <div /> }));

import { Header } from './Header';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Header sidebarOpen onSidebarToggle={vi.fn()} />
    </MemoryRouter>,
  );
}

describe('Header page title', () => {
  it('shows the localized "Subscriptions" on /subscriptions in every locale (never the "Page" fallback)', () => {
    for (const lang of Object.keys(LOCALES)) {
      currentLang = lang;
      const expected = resolve(LOCALES[lang], 'nav.subscriptions') as string;
      const { unmount } = renderAt('/subscriptions');
      expect(screen.getByText(expected)).toBeInTheDocument();
      expect(screen.queryByText(en.common.page as string)).not.toBeInTheDocument();
      unmount();
    }
    currentLang = 'en';
  });
});
