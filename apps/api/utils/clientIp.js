/**
 * Client IP resolution (#78 R3) — the one place the API decides which address
 * a request came from. Used by every rate limiter (utils/rateLimit.js), the
 * integration-key "last used" stamp and session records (utils/apiKeys.js
 * `requestIp`) and the MCP loopback IP forwarding (lib/mcp/loopback.js).
 *
 * The socket address is the default. A client-supplied header is honoured only
 * when:
 *  - the operator says a trusted proxy sets it: `TRUST_PROXY_IP_HEADER` =
 *    `x-real-ip` (used as-is) or `x-forwarded-for` (the RIGHTMOST entry — the
 *    one the trusted proxy appended; anything to its left is client-supplied);
 *  - or the socket is loopback, where the only caller is the API itself (the
 *    MCP server calling REST routes) forwarding the agent's IP in `x-real-ip`.
 *
 * Docker Compose publishes the API directly, so it leaves the variable unset.
 * Railway's edge overwrites `X-Real-IP` with the real client address, so
 * Railway sets `TRUST_PROXY_IP_HEADER=x-real-ip`.
 */

const SUPPORTED_HEADERS = new Set(['x-real-ip', 'x-forwarded-for']);
const LOOPBACK = new Set(['127.0.0.1', '::1']);

let warnedIgnoredHeader = false;

/** `::ffff:1.2.3.4` → `1.2.3.4`; trims; empty → null. */
export function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('::ffff:') && lower.slice(7).includes('.')) return trimmed.slice(7);
  return trimmed;
}

/** The configured trusted header name, or null (unset / unknown value). */
export function trustedProxyHeader() {
  const raw = (process.env.TRUST_PROXY_IP_HEADER || '').trim().toLowerCase();
  return SUPPORTED_HEADERS.has(raw) ? raw : null;
}

function headerValue(req, name) {
  const value = req?.headers?.[name];
  if (Array.isArray(value)) return value[value.length - 1];
  return typeof value === 'string' ? value : null;
}

function fromHeader(req, name) {
  const value = headerValue(req, name);
  if (!value) return null;
  if (name === 'x-forwarded-for') {
    const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
    return normalizeIp(parts[parts.length - 1]);
  }
  return normalizeIp(value);
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {string|null} the client address, or null when nothing is known
 */
export function clientIp(req) {
  const socketIp = normalizeIp(req?.socket?.remoteAddress);

  const trusted = trustedProxyHeader();
  if (trusted) {
    const proxied = fromHeader(req, trusted);
    if (proxied) return proxied;
    return socketIp;
  }

  if (socketIp && LOOPBACK.has(socketIp)) {
    return fromHeader(req, 'x-real-ip') || socketIp;
  }

  if (!warnedIgnoredHeader && headerValue(req, 'x-real-ip')) {
    warnedIgnoredHeader = true;
    console.warn(JSON.stringify({
      event: 'trust_proxy_header_ignored',
      message: 'X-Real-IP received but TRUST_PROXY_IP_HEADER is unset; rate limits use the socket address. Set TRUST_PROXY_IP_HEADER when the API runs behind a reverse proxy.',
    }));
  }
  return socketIp;
}

/** Test hook: re-arm the one-time warning. */
export function _resetClientIpWarning() {
  warnedIgnoredHeader = false;
}
