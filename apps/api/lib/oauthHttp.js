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

/** Token/revoke bodies are form-encoded; accept JSON too. */
export function formBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return Object.fromEntries(new URLSearchParams(req.body));
  return {};
}
