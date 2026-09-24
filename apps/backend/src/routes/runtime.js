const fs = require('fs');
const path = require('path');
const express = require('express');
const { StatusCodes } = require('http-status-codes');
const apiKeyAuth = require('../middleware/apiKeyAuth');

const router = express.Router();

/**
 * Runtime version reporting — what this instance is ACTUALLY running, as
 * opposed to what the lockfile says it should be.
 *
 * Why this is authenticated and NOT part of /health
 * -------------------------------------------------
 * /health and /health/metrics are deliberately unauthenticated so platform
 * health checks can reach them. Version strings must not go there. Exact
 * runtime and dependency versions are textbook information disclosure: they
 * turn an attacker's untargeted scan into a targeted CVE lookup against a host
 * already known to be vulnerable. That costs an attacker almost nothing and
 * buys them a great deal, so it is reported behind INTERNAL_API_KEY instead —
 * the operator has the key, and nobody else does.
 *
 * Worth having because a green build does not prove what shipped: a stale
 * layer cache, a platform-pinned runtime, or an override that silently failed
 * to apply all produce a successful deploy running the wrong versions.
 *
 * Usage:
 *   curl -H "x-api-key: $INTERNAL_API_KEY" https://<backend>/api/runtime
 */
router.use(apiKeyAuth);

/**
 * Packages whose resolved version is worth confirming at runtime.
 *
 * `via` exists because pnpm's isolated node_modules layout only makes a
 * service's OWN dependencies resolvable from its root. A pinned transitive
 * like `ws` is genuinely installed but invisible to a bare
 * require('ws/package.json') here — reporting it as absent would be worse than
 * not reporting it at all, because it looks like the override failed to apply.
 * Resolving from the dependent's directory instead finds the real thing.
 *
 * Scoped to what this service actually has. Packages that live only in
 * apps/api (sharp, postcss, nanoid, the OpenTelemetry tree) are deliberately
 * absent: they would report null on every call and that noise would make a
 * genuine null impossible to spot.
 */
const TRACKED_PACKAGES = [
  // Direct dependencies of apps/backend.
  { name: 'axios' },
  { name: 'express' },
  { name: 'bullmq' },
  { name: 'ioredis' },
  { name: '@prisma/client' },
  { name: 'openai' },
  { name: 'plaid' },
  // Transitives pinned by pnpm.overrides — the ones a failed override would
  // silently leave vulnerable.
  { name: 'ws', via: 'openai' },
  { name: 'lodash', via: 'express-validator' },
  { name: 'form-data', via: 'axios' },
];

/**
 * Walk up from a resolved file to the owning package's manifest.
 *
 * Needed because `require('<pkg>/package.json')` fails on any package whose
 * `exports` map omits "./package.json" — `openai` is one, and it reports
 * ERR_PACKAGE_PATH_NOT_EXPORTED rather than anything that looks like a missing
 * install. The package's main entry is always resolvable, so resolve that and
 * walk up instead.
 *
 * @param {string} entryPath
 * @param {string} name Expected package name, to avoid picking up a parent's
 *   manifest when a package has no package.json of its own.
 * @returns {string|null}
 */
function manifestVersionFrom(entryPath, name) {
  let dir = path.dirname(entryPath);

  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (pkg.name === name) return pkg.version ?? null;
    } catch {
      // No manifest here, or unreadable — keep walking.
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/**
 * Resolve an installed package's version.
 *
 * Each lookup is guarded individually: a package missing from this service's
 * tree must report null rather than turning the whole endpoint into a 500 —
 * otherwise the diagnostic breaks exactly when something is wrong enough to
 * need it.
 *
 * @param {string} name
 * @param {string} [via] Resolve from this package's directory instead of the
 *   service root, for transitives that pnpm does not hoist.
 * @returns {string|null}
 */
function resolveVersion(name, via) {
  try {
    let paths;
    if (via) {
      // Resolve the parent's ENTRY, not its package.json — the latter is
      // blocked by some packages' exports maps.
      paths = [path.dirname(require.resolve(via))];
    }

    const entry = require.resolve(name, paths ? { paths } : undefined);
    return manifestVersionFrom(entry, name);
  } catch {
    return null;
  }
}

/**
 * Versions cannot change for the lifetime of the process, and resolution walks
 * the filesystem, so compute once on first request rather than on every call.
 * Lazy rather than at module load so it costs nothing at boot.
 */
let cachedDependencies = null;

function getDependencies() {
  if (!cachedDependencies) {
    cachedDependencies = {};
    for (const { name, via } of TRACKED_PACKAGES) {
      cachedDependencies[name] = resolveVersion(name, via);
    }
  }
  return cachedDependencies;
}

router.get('/', (req, res) => {
  const dependencies = getDependencies();

  res.status(StatusCodes.OK).json({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    // Absent on musl (Alpine), present on glibc. Confirms which base image is
    // actually running, which matters for prebuilt native binaries.
    libc: process.report?.getReport?.()?.header?.glibcVersionRuntime ? 'glibc' : 'musl',
    startMode: process.env.START_MODE || 'all',
    uptime: process.uptime(),
    dependencies,
  });
});

module.exports = router;
