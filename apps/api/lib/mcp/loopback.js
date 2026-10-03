import { fetchWithTimeout } from '../../utils/fetchWithTimeout.js';

/**
 * Loopback REST client for MCP tools (#89).
 *
 * Every tool reaches Bliss data by calling an existing `/api/*` route over
 * HTTP with the caller's own `Authorization: Bearer bliss_…` key. withAuth,
 * the integration denylist, tenant scoping, decryption, validation, rate
 * limits and backend events therefore all run exactly as for a direct REST
 * call. This module never logs headers or bodies.
 */

const LOOPBACK_TIMEOUT_MS = 30_000;

export class LoopbackError extends Error {
  /**
   * @param {{ status: number, code?: string, error?: string, details?: unknown,
   *   retryAfter?: number|null, method: string, route: string }} info
   */
  constructor({ status, code, error, details, retryAfter = null, method, route }) {
    super(error || `REST call failed with status ${status}`);
    this.name = 'LoopbackError';
    this.status = status;
    this.code = code;
    this.error = error;
    this.details = details;
    this.retryAfter = retryAfter;
    this.method = method;
    this.route = route;
  }
}

/** Base URL of the API itself. `MCP_LOOPBACK_URL` overrides 127.0.0.1:$PORT. */
export function loopbackBaseUrl() {
  const override = process.env.MCP_LOOPBACK_URL;
  if (override) return override.replace(/\/+$/, '');
  return `http://127.0.0.1:${process.env.PORT || 3000}`;
}

/** Same expression as the rate limiters' keyGenerator (utils/rateLimit.js). */
export function clientIp(req) {
  const headers = req?.headers || {};
  return (
    headers['x-real-ip'] ||
    headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req?.socket?.remoteAddress ||
    '127.0.0.1'
  );
}

/** Build a query string. Arrays repeat the key; undefined/null/'' are dropped. */
export function buildQuery(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) if (v !== undefined && v !== null && v !== '') params.append(key, String(v));
    } else {
      params.append(key, String(value));
    }
  }
  return params.toString();
}

function parseRetryAfter(response, data) {
  const header = response.headers?.get?.('retry-after');
  const fromHeader = header != null ? parseInt(header, 10) : NaN;
  if (Number.isFinite(fromHeader)) return fromHeader;
  const fromBody = data && typeof data.retryAfter === 'number' ? data.retryAfter : NaN;
  return Number.isFinite(fromBody) ? fromBody : null;
}

/**
 * @param {Object} options
 * @param {import('http').IncomingMessage} options.req  The incoming MCP request.
 * @param {string} options.tool       Tool name, sent as `x-bliss-mcp-tool` for attribution.
 * @param {Function} [options.fetchImpl]  Injected in tests.
 */
export function createLoopbackClient({ req, tool, fetchImpl = fetchWithTimeout }) {
  const base = loopbackBaseUrl();
  const ip = clientIp(req);
  const headers = {
    authorization: req.headers.authorization,
    accept: 'application/json',
    'x-real-ip': ip,
    'x-forwarded-for': ip,
    'x-bliss-mcp-tool': tool,
  };
  if (req.headers['x-request-id']) headers['x-request-id'] = req.headers['x-request-id'];

  /** `{ method, route, status, ms }` for every REST call this tool made. */
  const calls = [];

  /**
   * With `withStatus`, resolves `{ status, data }` instead of `data`, for
   * routes whose 2xx status carries meaning (201 created vs 200 existing).
   */
  async function call(method, path, { query, body, withStatus = false } = {}) {
    const qs = buildQuery(query);
    const url = `${base}${path}${qs ? `?${qs}` : ''}`;
    const started = Date.now();
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetchImpl(url, init, LOOPBACK_TIMEOUT_MS);
    } catch (err) {
      calls.push({ method, route: path, status: 0, ms: Date.now() - started });
      throw new LoopbackError({
        status: 0,
        error: err?.name === 'AbortError' ? 'Bliss did not answer in time' : 'Bliss API is unreachable',
        method,
        route: path,
      });
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    calls.push({ method, route: path, status: response.status, ms: Date.now() - started });

    if (response.status < 200 || response.status >= 300) {
      throw new LoopbackError({
        status: response.status,
        code: data?.code,
        error: typeof data?.error === 'string' ? data.error : undefined,
        details: data?.details,
        retryAfter: parseRetryAfter(response, data),
        method,
        route: path,
      });
    }
    return withStatus ? { status: response.status, data } : data;
  }

  return {
    calls,
    call,
    get: (path, query) => call('GET', path, { query }),
    post: (path, body, query) => call('POST', path, { body, query }),
    postWithStatus: (path, body, query) => call('POST', path, { body, query, withStatus: true }),
    put: (path, body, query) => call('PUT', path, { body, query }),
    del: (path, query) => call('DELETE', path, { query }),
  };
}

/**
 * Fail-soft wrapper for secondary parts of a bundled read: a 404 resolves to
 * `fallback` instead of failing the whole tool.
 */
export async function optional(promise, fallback = null) {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof LoopbackError && err.status === 404) return fallback;
    throw err;
  }
}

/** Run `fn` over `items` with at most `limit` in flight. Results keep input order. */
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
