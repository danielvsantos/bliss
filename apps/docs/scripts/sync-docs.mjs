/**
 * sync-docs.mjs
 *
 * Pre-build script that copies documentation from the monorepo root `docs/`
 * folder into the Nextra content directory and public assets.
 *
 * Runs automatically via `predev` and `prebuild` npm hooks.
 *
 * What it does:
 *   1. Copies docs/architecture.md, configuration.md → content/
 *   2. Copies docs/guides/*.md → content/guides/
 *   3. Scans docs/specs/{api,backend,frontend}/ to build a feature manifest (specs-manifest.json)
 *      used by the Specifications page to generate dynamic GitHub links
 *   4. Copies docs/openapi/*.yaml → public/openapi/
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { resolve, basename, extname, join } from 'node:path';

const ROOT = resolve(process.cwd(), '../..');
const DOCS_DIR = resolve(ROOT, 'docs');
const CONTENT_DIR = resolve(process.cwd(), 'content');
const PUBLIC_DIR = resolve(process.cwd(), 'public');
const PUBLIC_OPENAPI = resolve(PUBLIC_DIR, 'openapi');

// ── Feature mapping ─────────────────────────────────────
// Maps feature slugs to display titles and spec file references.
// The sync script validates that files exist and writes a manifest for the UI.

const FEATURE_MAP = {
  'design-system':            { title: 'Design System',              order: 0,  description: 'Color tokens, typography, component patterns, and the Bliss UIKit' },
  'user-identity':            { title: 'User Identity & Auth',       order: 1,  description: 'Registration, sign-in, JWT sessions, Google OAuth, RBAC roles' },
  'accounts-and-categories':  { title: 'Accounts & Categories',      order: 2,  description: 'Multi-bank account management, category hierarchy, account owners' },
  'reference-data':           { title: 'Reference Data',             order: 3,  description: 'Countries, currencies, banks, and tenant configuration metadata' },
  'transactions':             { title: 'Transactions',               order: 4,  description: 'CRUD operations, filtering, bulk actions, and encrypted storage' },
  'analytics':                { title: 'Analytics',                  order: 5,  description: 'Spending aggregation, financial summary, tag analytics, and monthly caches' },
  'portfolio':                { title: 'Portfolio',                  order: 6,  description: 'FIFO lot tracking, real-time pricing, FX conversion, and valuations' },
  'cash-holdings':            { title: 'Cash Holdings',              order: 7,  description: 'Cash position tracking with forward-fill valuation' },
  'plaid-integration':        { title: 'Plaid Integration',          order: 8,  description: 'Bank sync, two-worker pipeline, token rotation, and sync logs' },
  'smart-import':             { title: 'Smart Import',               order: 9,  description: 'CSV/XLSX ingestion, adapter detection, dedup, and staged review' },
  'ai-classification':        { title: 'AI Classification & Review', order: 10, description: '4-tier classification waterfall, vector search, feedback loop' },
  'admin':                    { title: 'Admin API',                  order: 11, description: 'Internal admin endpoints for category provisioning' },
  'deployment':               { title: 'Deployment Architecture',    order: 12, description: 'Docker Compose, START_MODE, scaling strategy' },
  'testing':                  { title: 'Testing & Observability',    order: 13, description: 'Vitest + Jest suites, Sentry integration, CI/CD pipeline' },
  'notifications':            { title: 'Notification Center',        order: 14, description: 'In-app notification system with read/unread tracking' },
  'insights':                 { title: 'Insights Engine',            order: 15, description: 'AI-generated financial insights across 7 analysis lenses' },
  'dashboard-actions':        { title: 'Dashboard Actions',          order: 16, description: 'Dashboard widgets, quick actions, and onboarding checklist' },
  'tag-analytics':            { title: 'Tag Analytics',              order: 18, description: 'Multi-tag transaction analysis with dedicated cache tables' },
  'security-master':          { title: 'Security Master & Equity Analysis', order: 19, description: 'Nightly stock fundamentals refresh, equity deep-dive with earnings and dividends' },
};

// Maps feature slugs to actual filenames per layer (from docs/specs/)
const LAYER_FILES = {
  'design-system':            { frontend: '00-design-system.md' },
  'user-identity':            { api: '01-user-identity.md', frontend: '01-user-identity.md' },
  'accounts-and-categories':  { api: '02-accounts-and-categories.md', frontend: '02-accounts-and-categories.md' },
  'reference-data':           { api: '03-reference-data-management.md', frontend: '03-reference-data-management.md' },
  'transactions':             { api: '04-transactions.md', frontend: '04-transactions.md' },
  'analytics':                { api: '05-analytics-api.md', backend: '05-analytics.md', frontend: '05-analytics.md' },
  'portfolio':                { api: '06-portfolio-api.md', backend: '06-portfolio-processing.md', frontend: '06-portfolio-management.md' },
  'cash-holdings':            { backend: '07-cash-holdings.md' },
  'plaid-integration':        { api: '08-plaid-integration.md', backend: '08-plaid-integration.md', frontend: '08-plaid-integration.md' },
  'smart-import':             { api: '09-smart-import-api.md', backend: '09-smart-import.md', frontend: '09-smart-import-ui.md' },
  'ai-classification':        { api: '10-ai-classification-and-review.md', backend: '10-ai-classification-and-review.md', frontend: '10-ai-classification-and-review.md' },
  'admin':                    { api: '11-admin-api.md', backend: '11-admin-api.md' },
  'deployment':               { api: '12-deployment.md', backend: '12-deployment-architecture.md', frontend: '12-deployment.md' },
  'testing':                  { api: '13-automated-testing-and-error-logging.md', backend: '13-automated-testing-and-error-logging.md', frontend: '13-automated-testing-and-error-logging.md' },
  'notifications':            { api: '14-notification-center.md', frontend: '14-notification-center.md' },
  'insights':                 { api: '15-insights.md', backend: '15-insights-engine.md', frontend: '15-insights.md' },
  'dashboard-actions':        { frontend: '16-dashboard-actions.md' },
  'tag-analytics':            { api: '18-tag-analytics.md', backend: '18-tag-analytics.md', frontend: '18-tag-analytics.md' },
  'security-master':          { api: '19-security-master-api.md', backend: '19-security-master.md', frontend: '19-security-master.md' },
};

// ── Helpers ──────────────────────────────────────────────────

function cleanDir(dir) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
}

function slugFromFilename(filename) {
  const name = basename(filename, extname(filename));
  return name.replace(/^\d+-/, '');
}

function copyFile(srcPath, destPath) {
  const content = readFileSync(srcPath, 'utf-8');
  writeFileSync(destPath, content, 'utf-8');
}

// ── Main ─────────────────────────────────────────────────────

console.log('[sync-docs] Starting documentation sync...');

// 1. Clean old synced specs directory (no longer generated)
const specsTarget = join(CONTENT_DIR, 'specs');
if (existsSync(specsTarget)) {
  rmSync(specsTarget, { recursive: true, force: true });
  console.log('[sync-docs] Removed legacy content/specs/ directory');
}
cleanDir(PUBLIC_OPENAPI);
mkdirSync(CONTENT_DIR, { recursive: true });

// 2. Copy top-level foundation docs
const foundationDocs = ['architecture.md', 'configuration.md'];

for (const file of foundationDocs) {
  const srcPath = join(DOCS_DIR, file);
  if (!existsSync(srcPath)) {
    console.warn(`[sync-docs] Warning: ${file} not found, skipping`);
    continue;
  }
  const slug = slugFromFilename(file);
  const destPath = join(CONTENT_DIR, `${slug}.md`);
  copyFile(srcPath, destPath);
  console.log(`[sync-docs] Copied ${file} → content/${slug}.md`);
}

// 3. Copy guides
const guidesSource = join(DOCS_DIR, 'guides');
const guidesTarget = join(CONTENT_DIR, 'guides');
mkdirSync(guidesTarget, { recursive: true });

let guideCount = 0;
if (existsSync(guidesSource)) {
  const guideFiles = readdirSync(guidesSource).filter((f) => f.endsWith('.md'));
  for (const file of guideFiles) {
    copyFile(join(guidesSource, file), join(guidesTarget, file));
    console.log(`[sync-docs] Copied guides/${file} → content/guides/${file}`);
    guideCount++;
  }
}

// 4. Build specs manifest (JSON) for the Specifications page
const manifest = [];

for (const [featureSlug, feature] of Object.entries(FEATURE_MAP)) {
  const layers = LAYER_FILES[featureSlug] || {};
  const resolvedLayers = {};

  for (const [layer, filename] of Object.entries(layers)) {
    const srcPath = join(DOCS_DIR, 'specs', layer, filename);
    if (existsSync(srcPath)) {
      resolvedLayers[layer] = `docs/specs/${layer}/${filename}`;
    }
  }

  if (Object.keys(resolvedLayers).length > 0) {
    manifest.push({
      slug: featureSlug,
      title: feature.title,
      description: feature.description,
      order: feature.order,
      layers: resolvedLayers,
    });
  }
}

manifest.sort((a, b) => a.order - b.order);
writeFileSync(join(PUBLIC_DIR, 'specs-manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
console.log(`[sync-docs] Generated specs-manifest.json with ${manifest.length} features`);

// 5. Copy OpenAPI YAML files
const openapiDir = join(DOCS_DIR, 'openapi');
if (existsSync(openapiDir)) {
  const yamlFiles = readdirSync(openapiDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  for (const file of yamlFiles) {
    cpSync(join(openapiDir, file), join(PUBLIC_OPENAPI, file));
    console.log(`[sync-docs] Copied openapi/${file} → public/openapi/${file}`);
  }
}

console.log(`[sync-docs] Done! ${manifest.length} features, ${foundationDocs.length} foundation docs, ${guideCount} guides.`);
