import * as Sentry from '@sentry/nextjs';
import { fetchWithTimeout } from './fetchWithTimeout.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const BACKEND_API_KEY = process.env.INTERNAL_API_KEY;
if (!BACKEND_API_KEY) {
  console.warn('[produceEvent] INTERNAL_API_KEY not set — backend events will fail');
}

const MAX_RETRIES = 3;
const RETRY_DELAYS = [200, 1000, 3000]; // exponential-ish backoff (ms)
const FETCH_TIMEOUT_MS = 10_000;        // 10 s per attempt

/**
 * Sends a system event to the bliss-backend-service event bus.
 *
 * Retries up to MAX_RETRIES times with exponential backoff on network
 * errors or 5xx responses. Uses a 10 s fetch timeout per attempt so a
 * hung backend never blocks a Vercel serverless function indefinitely.
 *
 * On final failure: logs at error level and reports to Sentry, but
 * never throws — callers can safely fire-and-forget.
 *
 * @param {object} event - Must include a `type` string plus any payload fields.
 */
export async function produceEvent(event) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetchWithTimeout(
        `${BACKEND_URL}/api/events`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': BACKEND_API_KEY,
          },
          body: JSON.stringify(event),
        },
        FETCH_TIMEOUT_MS,
      );

      if (response.ok) return; // success

      // Non-retryable client errors (4xx except 429)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        let body = '';
        try { body = await response.text(); } catch (_) {}
        const message = `[produceEvent] Backend returned ${response.status} for ${event.type}: ${body}`;
        console.error(message);
        Sentry.captureMessage(message, {
          level: 'error',
          extra: { eventType: event.type, backendUrl: BACKEND_URL, status: response.status, body },
        });
        return; // don't retry 4xx
      }

      // 5xx or 429 — fall through to retry
      if (attempt < MAX_RETRIES - 1) {
        console.warn(`[produceEvent] Attempt ${attempt + 1}/${MAX_RETRIES} got ${response.status} for ${event.type}, retrying...`);
      }
    } catch (error) {
      // Network-level failure (ECONNREFUSED, DNS failure, AbortError from timeout, etc.)
      if (attempt < MAX_RETRIES - 1) {
        console.warn(`[produceEvent] Attempt ${attempt + 1}/${MAX_RETRIES} failed for ${event.type}: ${error.message}, retrying...`);
      } else {
        console.error(`[produceEvent] All ${MAX_RETRIES} attempts failed for ${event.type}: ${error.message}`);
        Sentry.captureException(error, {
          extra: { eventType: event.type, backendUrl: BACKEND_URL, attempt },
        });
        return;
      }
    }

    // Wait before next retry
    if (attempt < MAX_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }

  // Final attempt exhausted via the 5xx/429 path (no catch)
  console.error(`[produceEvent] All ${MAX_RETRIES} attempts exhausted for ${event.type}`);
  Sentry.captureMessage(`[produceEvent] All retries exhausted for ${event.type}`, {
    level: 'error',
    extra: { eventType: event.type, backendUrl: BACKEND_URL },
  });
}
