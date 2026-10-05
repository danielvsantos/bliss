import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Processing status (#100, PRD R5 / AC3, AC14): every page in the R5 table
 * mounts <DataUpdatingBanner> with its watch list (Tag Analytics watches
 * ANALYTICS_UPDATE — deviation D1), and no processing-status UI uses raw
 * Tailwind colours.
 */

const SRC = join(__dirname, '../..');

const PAGES: Array<[string, string[]]> = [
  ['pages/dashboard.tsx', ['ANALYTICS_UPDATE', 'PORTFOLIO_UPDATE']],
  ['pages/reports/expenses.tsx', ['ANALYTICS_UPDATE']],
  ['pages/reports/financial-summary.tsx', ['ANALYTICS_UPDATE']],
  ['pages/reports/tags.tsx', ['ANALYTICS_UPDATE']],
  ['pages/reports/portfolio.tsx', ['PORTFOLIO_UPDATE', 'SECURITY_DATA']],
  ['pages/reports/equity-analysis.tsx', ['PORTFOLIO_UPDATE', 'SECURITY_DATA']],
  ['pages/reports/passive-income.tsx', ['PORTFOLIO_UPDATE', 'SECURITY_DATA', 'ANALYTICS_UPDATE']],
  ['pages/subscriptions.tsx', ['SUBSCRIPTION_SCAN']],
  ['pages/accounts.tsx', ['BANK_SYNC']],
  ['pages/insights.tsx', ['INSIGHTS']],
];

describe('page banners (#100)', () => {
  it.each(PAGES)('%s mounts the banner watching %j', (file, watch) => {
    const src = readFileSync(join(SRC, file), 'utf8');
    const m = src.match(/<DataUpdatingBanner\s+watch=\{\[([^\]]*)\]\}\s+invalidate=\{\[(.+?)\]\}/);
    expect(m, 'banner mounted').not.toBeNull();
    const declared = m![1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
    expect(declared).toEqual(watch);
    expect(m![2].length, 'at least one query key to refresh').toBeGreaterThan(0);
  });
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [full] : [];
  });
}

describe('design tokens (#100, AC14)', () => {
  const targets = [
    ...files(join(SRC, 'components/processing')),
    join(SRC, 'components/settings/processing-tab.tsx'),
    join(SRC, 'components/settings/rebuild-history-list.tsx'),
  ];
  it.each(targets.map((t) => [t.replace(SRC, 'src')]))('%s uses no raw Tailwind colours', (rel) => {
    const src = readFileSync(join(SRC, rel.replace(/^src\//, '')), 'utf8');
    expect(src).not.toMatch(/\b(?:bg|text|border|from|to|ring)-(?:green|red|amber|blue|yellow|orange|indigo|purple|pink|emerald|rose|sky)-\d{2,3}\b/);
  });
});
