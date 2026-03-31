import fetch from 'node-fetch';
import * as Sentry from '@sentry/nextjs';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const BACKEND_API_KEY = process.env.INTERNAL_API_KEY;
if (!BACKEND_API_KEY) {
  console.warn('[produceEvent] INTERNAL_API_KEY not set — backend events will fail');
}

/**
 * Sends a system event to the bliss-backend-service event bus.
 * Logs and captures both network errors and non-2xx HTTP responses so
 * that silent failures (e.g. 401 auth mismatches, 404 wrong URL) are
 * visible in Vercel logs and Sentry.
 *
 * @param {object} event - Must include a `type` string plus any payload fields.
 */
export async function produceEvent(event) {
  let response;
  try {
    response = await fetch(`${BACKEND_URL}/api/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': BACKEND_API_KEY,
      },
      body: JSON.stringify(event),
    });
  } catch (error) {
    // Network-level failure (ECONNREFUSED, DNS failure, timeout, etc.)
    console.error(`[produceEvent] Network error dispatching ${event.type}: ${error.message}`);
    Sentry.captureException(error, {
      extra: { eventType: event.type, backendUrl: BACKEND_URL },
    });
    return;
  }

  if (!response.ok) {
    // HTTP error response (401 wrong API key, 404 wrong URL, 500 backend crash, etc.)
    let body = '';
    try { body = await response.text(); } catch (_) {}
    const message = `[produceEvent] Backend returned ${response.status} for ${event.type}: ${body}`;
    console.error(message);
    Sentry.captureMessage(message, {
      level: 'error',
      extra: { eventType: event.type, backendUrl: BACKEND_URL, status: response.status, body },
    });
  }
}
