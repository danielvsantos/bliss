/**
 * sync-docs.mjs
 *
 * Pre-build script that copies documentation from the monorepo root `docs/`
 * folder into the Nextra content directory and public assets.
 *
 * Runs automatically via `predev` and `prebuild` npm hooks.
 *
 * What it does:
 *   1. Copies docs/architecture.md, getting-started.md, configuration.md → content/
 *   2. Copies docs/specs/{api,backend,frontend}/*.md → content/specs/{feature}/{layer}.md
 *      grouped by feature (matching numeric prefix across layers)
 *   3. Generates _meta.ts sidebar files for feature-based navigation
 *   4. Copies docs/openapi/*.yaml → public/openapi/
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { resolve, basename, extname, join } from 'node:path';

const ROOT = resolve(process.cwd(), '../..');
const DOCS_DIR = resolve(ROOT, 'docs');
const CONTENT_DIR = resolve(process.cwd(), 'content');
const PUBLIC_OPENAPI = resolve(process.cwd(), 'public/openapi');

// ── Feature mapping ─────────────────────────────────────
// Maps feature slugs to their spec files across layers.
// Key = feature slug, value = { title, order, layers: { api?, backend?, frontend? } }
// The layer values are the actual filenames in docs/specs/{layer}/

const FEATURE_MAP = {
  'user-identity': {
    title: 'User Identity & Auth',
    order: 1,
    layers: {
      api: '01-user-identity.md',
      frontend: '01-user-identity.md',
    },
  },
  'accounts-and-categories': {
    title: 'Accounts & Categories',
    order: 2,
    layers: {
      api: '02-accounts-and-categories.md',
      frontend: '02-accounts-and-categories.md',
    },
  },
  'reference-data': {
    title: 'Reference Data',
    order: 3,
    layers: {
      api: '03-reference-data-management.md',
      frontend: '03-reference-data-management.md',
    },
  },
  'transactions': {
    title: 'Transactions',
    order: 4,
    layers: {
      api: '04-transactions.md',
      frontend: '04-transactions.md',
    },
  },
  'analytics': {
    title: 'Analytics',
    order: 5,
    layers: {
      api: '05-analytics-api.md',
      backend: '05-analytics.md',
      frontend: '05-analytics.md',
    },
  },
  'portfolio': {
    title: 'Portfolio',
    order: 6,
    layers: {
      api: '06-portfolio-api.md',
      backend: '06-portfolio-processing.md',
      frontend: '06-portfolio-management.md',
    },
  },
  'cash-holdings': {
    title: 'Cash Holdings',
    order: 7,
    layers: {
      backend: '07-cash-holdings.md',
    },
  },
  'plaid-integration': {
    title: 'Plaid Integration',
    order: 8,
    layers: {
      api: '08-plaid-integration.md',
      backend: '08-plaid-integration.md',
      frontend: '08-plaid-integration.md',
    },
  },
  'smart-import': {
    title: 'Smart Import',
    order: 9,
    layers: {
      api: '09-smart-import-api.md',
      backend: '09-smart-import.md',
      frontend: '09-smart-import-ui.md',
    },
  },
  'ai-classification': {
    title: 'AI Classification & Review',
    order: 10,
    layers: {
      api: '10-ai-classification-and-review.md',
      backend: '10-ai-classification-and-review.md',
      frontend: '10-ai-classification-and-review.md',
    },
  },
  'admin': {
    title: 'Admin',
    order: 11,
    layers: {
      api: '11-admin-api.md',
      backend: '11-admin-api.md',
    },
  },
  'deployment': {
    title: 'Deployment Architecture',
    order: 12,
    layers: {
      backend: '12-deployment-architecture.md',
    },
  },
  'testing': {
    title: 'Testing & Error Logging',
    order: 13,
    layers: {
      api: '13-automated-testing-and-error-logging.md',
      backend: '13-automated-testing-and-error-logging.md',
      frontend: '13-automated-testing-and-error-logging.md',
    },
  },
  'notifications': {
    title: 'Notification Center',
    order: 14,
    layers: {
      api: '14-notification-center.md',
      frontend: '14-notification-center.md',
    },
  },
  'insights': {
    title: 'Insights Engine',
    order: 15,
    layers: {
      api: '15-insights.md',
      backend: '15-insights-engine.md',
      frontend: '15-insights.md',
    },
  },
  'dashboard-actions': {
    title: 'Dashboard Actions',
    order: 16,
    layers: {
      frontend: '16-dashboard-actions.md',
    },
  },
  'tag-analytics': {
    title: 'Tag Analytics',
    order: 18,
    layers: {
      api: '18-tag-analytics.md',
      backend: '18-tag-analytics.md',
      frontend: '18-tag-analytics.md',
    },
  },
  'security-master': {
    title: 'Security Master',
    order: 19,
    layers: {
      api: '19-security-master-api.md',
      backend: '19-security-master.md',
    },
  },
  'equity-analysis': {
    title: 'Equity Analysis',
    order: 20,
    layers: {
      frontend: '19-equity-analysis.md',
    },
  },
  'design-system': {
    title: 'Design System',
    order: 0,
    layers: {
      frontend: '00-design-system.md',
    },
  },
};

const LAYER_TITLES = {
  api: 'API Layer',
  backend: 'Backend',
  frontend: 'Frontend',
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

function titleFromSlug(slug) {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function copyFile(srcPath, destPath) {
  const content = readFileSync(srcPath, 'utf-8');
  writeFileSync(destPath, content, 'utf-8');
}

function writeMetaTs(dir, entries) {
  const sorted = entries.sort((a, b) => a.order - b.order);
  const lines = sorted.map((e) => `  '${e.slug}': '${e.title}',`);
  const content = `export default {\n${lines.join('\n')}\n};\n`;
  writeFileSync(join(dir, '_meta.ts'), content, 'utf-8');
}

// ── Main ─────────────────────────────────────────────────────

console.log('[sync-docs] Starting documentation sync...');

// 1. Clean synced directories
const specsTarget = join(CONTENT_DIR, 'specs');
if (existsSync(specsTarget)) {
  rmSync(specsTarget, { recursive: true, force: true });
}
cleanDir(PUBLIC_OPENAPI);
mkdirSync(CONTENT_DIR, { recursive: true });

// 2. Copy top-level foundation docs
const foundationDocs = ['architecture.md', 'getting-started.md', 'configuration.md'];

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

// 3. Copy spec files organized by feature
mkdirSync(specsTarget, { recursive: true });
const featureEntries = [];

for (const [featureSlug, feature] of Object.entries(FEATURE_MAP)) {
  const featureDir = join(specsTarget, featureSlug);
  const layerEntries = [];
  let hasFiles = false;

  for (const [layer, filename] of Object.entries(feature.layers)) {
    const srcPath = join(DOCS_DIR, 'specs', layer, filename);
    if (!existsSync(srcPath)) {
      console.warn(`[sync-docs] Warning: specs/${layer}/${filename} not found, skipping`);
      continue;
    }

    mkdirSync(featureDir, { recursive: true });
    const destPath = join(featureDir, `${layer}.md`);
    copyFile(srcPath, destPath);
    hasFiles = true;
    layerEntries.push({ slug: layer, title: LAYER_TITLES[layer], order: layer === 'api' ? 0 : layer === 'backend' ? 1 : 2 });
    console.log(`[sync-docs] Copied specs/${layer}/${filename} → specs/${featureSlug}/${layer}.md`);
  }

  if (hasFiles) {
    // Generate _meta.ts for this feature's layers
    const metaEntries = [
      { slug: 'index', title: 'Overview', order: -1 },
      ...layerEntries,
    ];
    writeMetaTs(featureDir, metaEntries);

    // Generate an index page for the feature folder
    const layerLinks = layerEntries
      .sort((a, b) => a.order - b.order)
      .map((l) => `- **[${l.title}](/docs/specs/${featureSlug}/${l.slug})** — ${l.title} implementation details`)
      .join('\n');
    const indexContent = `# ${feature.title}\n\nThis feature is documented across the following layers:\n\n${layerLinks}\n`;
    writeFileSync(join(featureDir, 'index.md'), indexContent, 'utf-8');

    featureEntries.push({ slug: featureSlug, title: feature.title, order: feature.order });
  }
}

// Generate specs-level _meta.ts
if (featureEntries.length > 0) {
  writeMetaTs(specsTarget, featureEntries);
}

// 4. Copy OpenAPI YAML files
const openapiDir = join(DOCS_DIR, 'openapi');
if (existsSync(openapiDir)) {
  const yamlFiles = readdirSync(openapiDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  for (const file of yamlFiles) {
    cpSync(join(openapiDir, file), join(PUBLIC_OPENAPI, file));
    console.log(`[sync-docs] Copied openapi/${file} → public/openapi/${file}`);
  }
}

console.log(`[sync-docs] Done! ${featureEntries.length} features, ${foundationDocs.length} foundation docs.`);
