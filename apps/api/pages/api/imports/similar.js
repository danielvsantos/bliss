import { StatusCodes } from 'http-status-codes';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { cors } from '../../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { withAuth } from '../../../utils/withAuth.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const BACKEND_API_KEY = process.env.INTERNAL_API_KEY;

/**
 * GET /api/imports/similar?description=<text>&limit=5&threshold=0.70
 *
 * Returns top-N previously classified transactions similar to the given
 * description text, using pgvector cosine similarity (Tier 2 vector search).
 *
 * Useful for "did you mean?" suggestions in the import review UI.
 *
 * Auth: JWT
 * Rate limit: importsAdapters limiter (30 req / 5 min)
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

  const user = req.user;

  // ── Validate query params ─────────────────────────────────────────────────
  const { description, limit = '5', threshold = '0.70' } = req.query;

  if (!description || typeof description !== 'string' || !description.trim()) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'description query param is required' });
  }

  // ── Proxy to backend-service similarity search ────────────────────────────
  try {
    const params = new URLSearchParams({
      description: description.trim(),
      tenantId: user.tenantId,
      limit,
      threshold,
    });

    const backendRes = await fetch(`${BACKEND_URL}/api/similar?${params}`, {
      method: 'GET',
      headers: { 'x-api-key': BACKEND_API_KEY },
    });

    if (!backendRes.ok) {
      const errBody = await backendRes.text();
      console.error(`Backend similar search returned ${backendRes.status}: ${errBody}`);
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'Failed to fetch similar transactions',
      });
    }

    const results = await backendRes.json();
    return res.status(StatusCodes.OK).json(results);
  } catch (error) {
    Sentry.captureException(error);
    console.error('Similar search proxy error:', error.message);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
