import { StatusCodes } from 'http-status-codes';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { cors } from '../../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { withAuth } from '../../../utils/withAuth.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const BACKEND_API_KEY = process.env.INTERNAL_API_KEY;

/**
 * GET /api/ticker/search?q=<query>&type=<stock|crypto>
 *
 * JWT-authenticated proxy to backend ticker search.
 * All search types route to Twelve Data. When type=crypto, results are filtered
 * and deduplicated to return base crypto symbols.
 * Returns: { results: [{ symbol, name, exchange, country, currency, type, mic_code }] }
 */
export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.importsAdapters(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).json({ error: 'Method not allowed' });
  }

  const { q, type } = req.query;

  if (!q || typeof q !== 'string' || !q.trim()) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'q query param is required' });
  }

  try {
    const params = new URLSearchParams({ q: q.trim() });
    if (type) params.set('type', type);

    const backendRes = await fetch(`${BACKEND_URL}/api/ticker/search?${params}`, {
      method: 'GET',
      headers: { 'x-api-key': BACKEND_API_KEY },
    });

    if (!backendRes.ok) {
      const errBody = await backendRes.text();
      console.error(`Backend ticker search returned ${backendRes.status}: ${errBody}`);
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'Failed to search tickers',
      });
    }

    const results = await backendRes.json();
    return res.status(StatusCodes.OK).json(results);
  } catch (error) {
    Sentry.captureException(error);
    console.error('Ticker search proxy error:', error.message);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
