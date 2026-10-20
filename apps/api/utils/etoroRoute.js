/**
 * Shared route plumbing for /api/etoro/* (#143): rate limit, and the error
 * mapping. Every /api/etoro route is session-only (INTEGRATION_DENYLIST).
 */

import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { rateLimiters } from './rateLimit.js';
import { EtoroServiceError } from '../services/etoro.service.js';

export function applyEtoroRateLimit(req, res) {
  return new Promise((resolve, reject) => {
    rateLimiters.etoro(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      return resolve(result);
    });
  });
}

/** Known errors → their status and body; anything else → 500 (Sentry, never the request body: it may hold keys). */
export function sendEtoroError(res, error, label) {
  if (error instanceof EtoroServiceError) return res.status(error.status).json(error.body);
  Sentry.captureException(error);
  console.error(`[etoro/${label}] failed:`, error.message);
  return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Server Error' });
}

export function forbidden(res) {
  return res.status(StatusCodes.FORBIDDEN).json({ error: 'Only workspace admins can manage eToro connections', code: 'ADMIN_ONLY' });
}
