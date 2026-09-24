const fs = require('fs');
const path = require('path');

/**
 * Runtime self-description for a Bliss service — what this process is ACTUALLY
 * running, as opposed to what the lockfile says it should be.
 *
 * A green build does not prove what shipped: a stale layer cache, a
 * platform-pinned runtime, or a `pnpm.overrides` entry that silently failed to
 * apply all produce a successful deploy on the wrong versions. Nothing in this
 * service logs any of it at boot, so without this there is no way to tell from
 * outside the container.
 *
 * Consumed by `routes/runtime.js` (the web instance answers for itself) and by
 * `workerHeartbeat.js` (the worker instance, which has no HTTP server at all,
 * publishes the same shape to Redis).
 */

/**
 * Packages whose resolved version is worth confirming at runtime.
 *
 * `via` exists because pnpm's isolated node_modules layout only makes a
 * service's OWN dependencies resolvable from its root. A pinned transitive like
 * `ws` is genuinely installed but invisible to a bare
 * require('ws/package.json') — reporting it as absent would be worse than not
 * reporting it, because it looks exactly like the override having failed to
 * apply. Resolving from the dependent's directory finds the real thing.
 *
 * Scoped to what this service actually has. Packages that live only in apps/api
 * (sharp, postcss, nanoid, the OpenTelemetry tree) are deliberately absent:
 * they would report null on every call, and that noise would make a genuine
 * null impossible to spot.
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
 * ERR_PACKAGE_PATH_NOT_EXPORTED rather than anything resembling a missing
 * install. A package's main entry is always resolvable, so resolve that and
 * walk up instead.
 *
 * @param {string} entryPath
 * @param {string} name Expected package name, so a package without its own
 *   manifest does not pick up a parent's.
 * @returns {string|null}
 */
function manifestVersionFrom(entryPath, name) {
  let dir = path.dirname(entryPath);

  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
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
 * Guarded individually: a package missing from this service's tree must report
 * null rather than throwing, or the diagnostic breaks exactly when something is
 * wrong enough to need it.
 *
 * @param {string} name
 * @param {string} [via]
 * @returns {string|null}
 */
function resolveVersion(name, via) {
  try {
    // Resolve the parent's ENTRY, not its package.json — the latter is blocked
    // by some packages' exports maps.
    const paths = via ? [path.dirname(require.resolve(via))] : undefined;
    const entry = require.resolve(name, paths ? { paths } : undefined);
    return manifestVersionFrom(entry, name);
  } catch {
    return null;
  }
}

/**
 * Versions cannot change for the lifetime of the process and resolution walks
 * the filesystem, so compute once. Lazy, so it costs nothing at boot.
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

/**
 * The commit this container was built from.
 *
 * Railway injects RAILWAY_GIT_COMMIT_SHA automatically; GIT_COMMIT_SHA is the
 * generic fallback for Docker Compose and self-hosters who choose to pass it.
 * Unknown is an honest answer — better than omitting the field, which would
 * read as "this deploy has no commit" rather than "nobody told me".
 */
function getCommit() {
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || null;
  return sha ? sha.slice(0, 12) : 'unknown';
}

/**
 * @param {string} role Which Bliss process this is: 'backend-web' or 'backend-worker'.
 * @returns {object}
 */
function getRuntimeInfo(role) {
  return {
    role,
    commit: getCommit(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    // Absent on musl (Alpine), present on glibc. Confirms which base image is
    // actually running, which matters for prebuilt native binaries.
    libc: process.report?.getReport?.()?.header?.glibcVersionRuntime ? 'glibc' : 'musl',
    startMode: process.env.START_MODE || 'all',
    uptimeSeconds: Math.round(process.uptime()),
    dependencies: getDependencies(),
  };
}

module.exports = { getRuntimeInfo, getCommit, TRACKED_PACKAGES };
