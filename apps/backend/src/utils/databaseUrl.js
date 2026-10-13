/**
 * Applies a default Prisma pool size to a Postgres connection string (#135).
 *
 * Without `connection_limit`, Prisma sizes each pool at `num_cpus * 2 + 1`,
 * and on a container host Node sees the *host's* CPUs — so a handful of
 * services and replicas can open more connections than Postgres allows
 * (`FATAL: sorry, too many clients already`).
 *
 * An explicit `connection_limit` / `pool_timeout` in the URL always wins; this
 * only fills in what is missing. Non-Postgres URLs (e.g. `prisma://`) and
 * unparseable values are returned unchanged.
 *
 * @param {string|undefined} url
 * @param {{ connectionLimit: number, poolTimeout?: number }} defaults
 * @returns {string|undefined}
 */
function withPoolDefaults(url, { connectionLimit, poolTimeout = 20 }) {
  if (!url || !/^postgres(ql)?:\/\//i.test(url)) return url;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (!parsed.searchParams.has('connection_limit')) {
    parsed.searchParams.set('connection_limit', String(connectionLimit));
  }
  if (!parsed.searchParams.has('pool_timeout')) {
    parsed.searchParams.set('pool_timeout', String(poolTimeout));
  }
  return parsed.toString();
}

/**
 * Default pool size for this backend process. `START_MODE=web` only serves the
 * internal HTTP API; workers (and `all`) run up to 5 concurrent portfolio jobs.
 *
 * @param {string|undefined} startMode
 * @returns {number}
 */
function defaultBackendConnectionLimit(startMode) {
  return startMode === 'web' ? 5 : 10;
}

module.exports = { withPoolDefaults, defaultBackendConnectionLimit };
