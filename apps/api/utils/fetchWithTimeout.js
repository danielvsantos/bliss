import fetch from 'node-fetch';

/**
 * Wraps node-fetch with an AbortController-based timeout.
 * Prevents serverless functions from hanging indefinitely on
 * unresponsive downstream services.
 *
 * @param {string}  url
 * @param {object}  [options]    — Standard fetch options (method, headers, body, etc.)
 * @param {number}  [timeoutMs]  — Timeout in milliseconds (default 10 000)
 * @returns {Promise<Response>}
 * @throws {AbortError} if the timeout fires before a response arrives
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
