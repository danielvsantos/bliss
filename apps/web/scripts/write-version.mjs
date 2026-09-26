#!/usr/bin/env node
/**
 * Writes `public/version.json` before the Vite build so it is copied into
 * `dist/` and served by nginx at `/version.json`.
 *
 * The web service is a static bundle behind nginx — there is no Node process at
 * runtime, so it cannot report anything about itself the way the API and
 * backend do. Its version has to be baked in at build time.
 *
 * Deliberately records only the commit and the build timestamp, **not**
 * dependency versions. This file is served publicly, and while the bundle's
 * contents are inherently public anyway, there is no reason to hand over a
 * machine-readable dependency inventory for free. The commit is the fact worth
 * having: it answers "which code is actually live", which is the question you
 * ask on every deploy.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(__dirname, '../public/version.json');

// Railway injects RAILWAY_GIT_COMMIT_SHA into builds; GIT_COMMIT_SHA is the
// generic fallback for Docker Compose and self-hosters who pass it as a build
// arg. 'unknown' is honest — an absent field would read as "no commit".
const sha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || null;

const version = {
  role: 'web',
  commit: sha ? sha.slice(0, 12) : 'unknown',
  buildTime: new Date().toISOString(),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(version, null, 2)}\n`);

console.log(`[version] wrote ${outputPath}: ${version.commit} @ ${version.buildTime}`);
