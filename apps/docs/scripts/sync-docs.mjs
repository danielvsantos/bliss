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
 *   2. Copies docs/specs/{api,backend,frontend}/*.md → content/specs/{layer}/
 *   3. Generates _meta.ts sidebar files from numeric filename prefixes
 *   4. Copies docs/openapi/*.yaml → public/openapi/
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { resolve, basename, extname, join } from 'node:path';

const ROOT = resolve(process.cwd(), '../..');
const DOCS_DIR = resolve(ROOT, 'docs');
const CONTENT_DIR = resolve(process.cwd(), 'content');
const PUBLIC_OPENAPI = resolve(process.cwd(), 'public/openapi');

// ── Helpers ──────────────────────────────────────────────────

function cleanDir(dir) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
}

function slugFromFilename(filename) {
  // "05-analytics.md" → "analytics"
  // "00-design-system.md" → "design-system"
  const name = basename(filename, extname(filename));
  return name.replace(/^\d+-/, '');
}

function titleFromSlug(slug) {
  // "design-system" → "Design System"
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function orderFromFilename(filename) {
  const match = basename(filename).match(/^(\d+)-/);
  return match ? parseInt(match[1], 10) : 999;
}

function copyAsMdx(srcPath, destPath) {
  const content = readFileSync(srcPath, 'utf-8');
  writeFileSync(destPath, content, 'utf-8');
}

function generateMetaTs(dir, entries) {
  // Nextra 4 _meta.ts format: export default { slug: 'Title', ... }
  const sorted = entries.sort((a, b) => a.order - b.order);
  const lines = sorted.map((e) => `  '${e.slug}': '${e.title}',`);
  const content = `export default {\n${lines.join('\n')}\n};\n`;
  writeFileSync(join(dir, '_meta.ts'), content, 'utf-8');
}

// ── Main ─────────────────────────────────────────────────────

console.log('[sync-docs] Starting documentation sync...');

// 1. Clean only synced directories (preserve hand-authored files)
// Clean specs (fully generated) and openapi
const specsTarget = join(CONTENT_DIR, 'specs');
if (existsSync(specsTarget)) {
  rmSync(specsTarget, { recursive: true, force: true });
}
cleanDir(PUBLIC_OPENAPI);
mkdirSync(CONTENT_DIR, { recursive: true });

// 2. Copy top-level foundation docs (overwrite on each sync)
const foundationDocs = ['architecture.md', 'getting-started.md', 'configuration.md'];

for (const file of foundationDocs) {
  const srcPath = join(DOCS_DIR, file);
  if (!existsSync(srcPath)) {
    console.warn(`[sync-docs] Warning: ${file} not found, skipping`);
    continue;
  }
  const slug = slugFromFilename(file);
  const destPath = join(CONTENT_DIR, `${slug}.md`);
  copyAsMdx(srcPath, destPath);
  console.log(`[sync-docs] Copied ${file} → content/${slug}.md`);
}

// 3. Copy spec files by layer
const specLayers = ['api', 'backend', 'frontend'];
const specsMeta = [];

for (const layer of specLayers) {
  const srcDir = join(DOCS_DIR, 'specs', layer);
  if (!existsSync(srcDir)) {
    console.warn(`[sync-docs] Warning: specs/${layer}/ not found, skipping`);
    continue;
  }

  const destDir = join(CONTENT_DIR, 'specs', layer);
  mkdirSync(destDir, { recursive: true });

  const files = readdirSync(srcDir).filter((f) => f.endsWith('.md'));
  const layerEntries = [];

  for (const file of files) {
    const slug = slugFromFilename(file);
    const order = orderFromFilename(file);
    const title = titleFromSlug(slug);

    copyAsMdx(join(srcDir, file), join(destDir, `${slug}.md`));
    layerEntries.push({ slug, title, order });
    console.log(`[sync-docs] Copied specs/${layer}/${file} → specs/${layer}/${slug}.md`);
  }

  // Generate _meta.ts for this layer
  generateMetaTs(destDir, layerEntries);

  specsMeta.push({
    slug: layer,
    title: layer === 'api' ? 'API Layer' : layer === 'backend' ? 'Backend' : 'Frontend',
    order: specLayers.indexOf(layer),
  });
}

// Generate specs-level _meta.ts
const specsDir = join(CONTENT_DIR, 'specs');
if (existsSync(specsDir)) {
  generateMetaTs(specsDir, specsMeta);
}

// NOTE: Top-level _meta.ts is hand-authored in content/_meta.ts
// The sync script only generates _meta.ts files inside specs/ subdirectories

// 4. Copy OpenAPI YAML files
const openapiDir = join(DOCS_DIR, 'openapi');
if (existsSync(openapiDir)) {
  const yamlFiles = readdirSync(openapiDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  for (const file of yamlFiles) {
    cpSync(join(openapiDir, file), join(PUBLIC_OPENAPI, file));
    console.log(`[sync-docs] Copied openapi/${file} → public/openapi/${file}`);
  }
}

console.log('[sync-docs] Documentation sync complete!');
