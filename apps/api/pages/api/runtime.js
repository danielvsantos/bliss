/**
 * GET /api/runtime — what is actually deployed, across every Bliss service.
 *
 * A green build does not prove what shipped. A stale layer cache, a
 * platform-pinned runtime, or a `pnpm.overrides` entry that silently failed to
 * apply all produce a successful deploy running the wrong versions, and nothing
 * logs any of it at boot.
 *
 * This is the only service reachable from a browser, so it aggregates:
 *
 *   api            this process, directly
 *   backend-web    fetched over the private network with INTERNAL_API_KEY
 *   backend-worker read from Redis by backend-web — the worker service runs
 *                  START_MODE=worker and never calls app.listen(), so it has no
 *                  HTTP surface at all and can only self-report
 *   web            build-time stamp from the static bundle's version.json
 *
 * Auth: `x-admin-key` / ADMIN_API_KEY — the operator credential, distinct from
 * the service-to-service INTERNAL_API_KEY. Not public, because exact runtime
 * and dependency versions are information disclosure: they turn an untargeted
 * scan into a targeted CVE lookup against a host already known to be
 * vulnerable.
 *
 * Every downstream lookup degrades to a status object rather than failing the
 * response — a partial answer during an incident is far more useful than a 500,
 * and "backend unreachable" is itself a finding.
 *
 *   curl -H "x-admin-key: $ADMIN_API_KEY" https://<api>/api/runtime
 */

import { StatusCodes } from 'http-status-codes';
import { createRequire } from 'module';
import { isAdminAuthorized } from '../../utils/adminAuth.js';

const require = createRequire(import.meta.url);

/** How long to wait on a downstream service before reporting it unreachable. */
const DOWNSTREAM_TIMEOUT_MS = 5000;

/**
 * Packages worth confirming in the API's own tree. Mirrors the backend's list
 * in spirit but covers what actually lives here — notably `next` and the
 * transitives it pins (`sharp`, `postcss`, `nanoid`), which are the ones the
 * original dependency triage got wrong: bumping `next` does NOT clear them.
 */
const TRACKED_PACKAGES = [
  { name: 'next' },
  { name: 'next-auth' },
  { name: 'axios' },
  { name: '@prisma/client' },
  { name: 'sharp', via: 'next' },
  { name: 'postcss', via: 'next' },
  { name: 'nanoid', via: 'postcss' },
  { name: 'form-data', via: 'axios' },
];

const fs = require('fs');
const path = require('path');

/** Walk up from a resolved file to the owning package's manifest. */
function manifestVersionFrom(entryPath, name) {
  let dir = path.dirname(entryPath);

  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.name === name) return pkg.version ?? null;
    } catch {
      // Keep walking.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Look for `<base>/../node_modules/<name>/package.json`, walking upward. */
function manifestFromNodeModules(base, name) {
  let dir = base;

  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(dir, 'node_modules', name, 'package.json'), 'utf8'),
      );
      if (pkg.name === name) return pkg.version ?? null;
    } catch {
      // Not here — keep walking up.
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
 * Tries several bases before giving up, so that **null means the package is
 * genuinely not installed in this image** rather than "the lookup failed".
 * That distinction matters more here than anywhere: `sharp`, `postcss` and
 * `nanoid` all carried advisories, and a null that might mean either thing
 * would make a vulnerable version and an absent one look identical.
 *
 * Several bases are needed because Next's standalone output prunes and
 * restructures node_modules by static tracing, so a package reachable through
 * its `via` parent in the dev tree may only be reachable from the service root
 * once deployed.
 *
 * The final filesystem sweep catches packages `require.resolve` cannot reach at
 * all — one whose `exports` map declares no usable CJS entry still has a
 * manifest on disk.
 */
function resolveVersion(name, via) {
  const bases = [];

  if (via) {
    try {
      bases.push(path.dirname(require.resolve(via)));
    } catch {
      // Parent not installed; the other bases may still find the child.
    }
  }
  bases.push(process.cwd());

  for (const base of bases) {
    try {
      const entry = require.resolve(name, { paths: [base] });
      const version = manifestVersionFrom(entry, name);
      if (version) return version;
    } catch {
      // Try the next base.
    }
  }

  for (const base of bases) {
    const version = manifestFromNodeModules(base, name);
    if (version) return version;
  }

  return null;
}

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
 * Railway injects RAILWAY_GIT_COMMIT_SHA automatically. GIT_COMMIT_SHA is the
 * generic fallback for Docker Compose and self-hosters. 'unknown' is an honest
 * answer — omitting the field would read as "no commit" rather than "nobody
 * told me".
 */
function getCommit() {
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || null;
  return sha ? sha.slice(0, 12) : 'unknown';
}

function getApiRuntime() {
  return {
    role: 'api',
    commit: getCommit(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    libc: process.report?.getReport?.()?.header?.glibcVersionRuntime ? 'glibc' : 'musl',
    uptimeSeconds: Math.round(process.uptime()),
    dependencies: getDependencies(),
  };
}

/** Fetch JSON with a timeout, never throwing. */
async function fetchJson(url, { headers = {} } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      return { status: 'error', note: `HTTP ${response.status} from ${url}` };
    }
    return await response.json();
  } catch (error) {
    const reason = error.name === 'AbortError' ? `timed out after ${DOWNSTREAM_TIMEOUT_MS}ms` : error.message;
    return { status: 'unreachable', note: reason };
  } finally {
    clearTimeout(timeout);
  }
}

async function getBackendRuntime() {
  const backendUrl = process.env.BACKEND_URL;
  if (!backendUrl) return { status: 'not-configured', note: 'BACKEND_URL is not set' };

  const apiKey = process.env.INTERNAL_API_KEY;
  if (!apiKey) return { status: 'not-configured', note: 'INTERNAL_API_KEY is not set' };

  return fetchJson(`${backendUrl.replace(/\/$/, '')}/api/runtime`, {
    headers: { 'x-api-key': apiKey },
  });
}

async function getWebRuntime() {
  const frontendUrl = process.env.FRONTEND_URL;
  if (!frontendUrl) return { status: 'not-configured', note: 'FRONTEND_URL is not set' };

  return fetchJson(`${frontendUrl.replace(/\/$/, '')}/version.json`);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    res.status(StatusCodes.METHOD_NOT_ALLOWED).json({ error: 'Method not allowed' });
    return;
  }

  if (!isAdminAuthorized(req, 'runtime')) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' });
    return;
  }

  // In parallel: neither downstream depends on the other, and a slow backend
  // should not add its latency to the frontend lookup.
  const [backend, web] = await Promise.all([getBackendRuntime(), getWebRuntime()]);

  // The worker rides along inside the backend's payload, since only the
  // backend can read its Redis heartbeat. Lifted to the top level here so the
  // four services read as peers.
  const { worker, ...backendWeb } = backend ?? {};

  res.status(StatusCodes.OK).json({
    checkedAt: new Date().toISOString(),
    services: {
      api: getApiRuntime(),
      backendWeb,
      backendWorker: worker ?? { status: 'unknown', note: 'Backend did not report a worker heartbeat' },
      web,
    },
  });
}
