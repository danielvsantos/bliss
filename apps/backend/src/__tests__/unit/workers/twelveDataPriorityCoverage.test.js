/**
 * Static check (#150): every worker or route that can reach Twelve Data,
 * directly or through stock/crypto/currency/price services, must run inside a
 * Twelve Data priority context. Otherwise its calls silently take the default
 * priority and its credits never show up in a `twelve_data_usage` log line.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../../..');
const TARGET = path.join(SRC, 'services/twelveDataService.js');

/** Files that reach the service through a require but never call it themselves. */
const EXEMPT = {
  'workers/commitWorker.js': 'run only by smartImportWorker, inside its wrapped processor',
  'routes/insights.js': 'imports VALID_TIERS from insightService; generation is enqueued, not run inline',
};

function resolveRequire(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const requireCache = new Map();
function localRequires(file) {
  if (!requireCache.has(file)) {
    const src = fs.readFileSync(file, 'utf8');
    const deps = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)]
      .map((m) => resolveRequire(file, m[1]))
      .filter(Boolean);
    requireCache.set(file, deps);
  }
  return requireCache.get(file);
}

function reachesTwelveData(file) {
  const seen = new Set();
  const stack = [file];
  while (stack.length) {
    const f = stack.pop();
    if (f === TARGET) return true;
    if (seen.has(f)) continue;
    seen.add(f);
    stack.push(...localRequires(f));
  }
  return false;
}

const entryFiles = (dir) => fs.readdirSync(path.join(SRC, dir))
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.join(SRC, dir, f));

const entries = [...entryFiles('workers'), ...entryFiles('routes')]
  .filter((file) => reachesTwelveData(file))
  .map((file) => path.relative(SRC, file));

describe('Twelve Data priority coverage (#150)', () => {
  it('finds the known Twelve Data callers (sanity)', () => {
    expect(entries).toEqual(expect.arrayContaining([
      'workers/securityMasterWorker.js',
      'workers/portfolioWorker.js',
      'workers/smartImportWorker.js',
      'routes/ticker.js',
      'routes/pricing.js',
    ]));
  });

  it('the bank and eToro syncs (plaid-sync queue) never reach Twelve Data', () => {
    // eToro copy values are stored in eToro's currency; FX happens in valuation (#143).
    expect(entries).not.toContain('workers/plaidSyncWorker.js');
  });

  it.each(entries)('%s runs its Twelve Data calls inside a priority context', (rel) => {
    if (EXEMPT[rel]) return;
    const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
    expect(src).toMatch(/withTwelveDataPriority\(|twelveDataRouteContext\(|runWithTwelveDataContext\(/);
  });
});
