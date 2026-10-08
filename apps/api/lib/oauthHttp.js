import { rateLimiters } from '../utils/rateLimit.js';

/**
 * Shared plumbing for the public OAuth endpoints (#89): permissive CORS (they
 * carry no cookies — browser-based MCP clients such as the Inspector call
 * them), OPTIONS preflight, rate limiting and RFC 6749 JSON errors.
 */

/** @returns {boolean} true when the request was a preflight and is answered. */
export function publicCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

export function limit(req, res, name = 'oauth') {
  return new Promise((resolve, reject) => {
    rateLimiters[name](req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });
}

export function oauthError(res, err) {
  return res.status(err.status || 400).json({
    error: err.error || 'invalid_request',
    ...(err.description && { error_description: err.description }),
  });
}

/**
 * Token/revoke bodies are form-encoded; accept JSON too. A client that sends
 * its client_id by HTTP Basic (client_secret_basic habits) gets it read from
 * there. Any secret is ignored: every client is public, so PKCE and the
 * refresh-token binding remain the only proof of possession.
 */
export function formBody(req) {
  let body = {};
  if (req.body && typeof req.body === 'object') body = req.body;
  else if (typeof req.body === 'string') body = Object.fromEntries(new URLSearchParams(req.body));
  if (!body.client_id) {
    const clientId = basicClientId(req.headers?.authorization);
    if (clientId) body = { ...body, client_id: clientId };
  }
  return body;
}

/** client_id from `Authorization: Basic base64(urlencode(id):urlencode(secret))` (RFC 6749 §2.3.1). */
export function basicClientId(header) {
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})\s*$/i.exec(String(header || ''));
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  const raw = sep === -1 ? decoded : decoded.slice(0, sep);
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' ')) || null;
  } catch {
    return null;
  }
}
