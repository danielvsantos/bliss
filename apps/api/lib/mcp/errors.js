import * as Sentry from '@sentry/nextjs';
import { LoopbackError } from './loopback.js';

/**
 * REST → MCP error mapping (#89). Tool failures are returned as MCP tool
 * results with `isError: true` and one short, actionable sentence, never as
 * protocol errors, so the agent can read them and recover.
 */

/** Thrown by tool handlers for input problems zod cannot express. */
export class ToolInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/** Thrown by tool handlers when an ID does not belong to this tenant. */
export class ToolNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolNotFoundError';
  }
}

function detailText(details) {
  if (typeof details === 'string') return details;
  if (Array.isArray(details) && details[0]?.message) return details.map((d) => d.message).join('; ');
  return null;
}

/**
 * @param {unknown} err
 * @param {{ tool: string, notFoundHint?: string }} context
 * @returns {string} the message shown to the agent
 */
export function errorMessage(err, { tool, notFoundHint } = {}) {
  const hint = notFoundHint ? ` ${notFoundHint}` : '';

  if (err instanceof ToolInputError) return err.message;
  if (err instanceof ToolNotFoundError) return `Not found: ${err.message}.${hint}`;

  if (err instanceof LoopbackError) {
    const { status, code } = err;
    if (status === 401) return 'The Bliss API key is invalid, expired or revoked. Ask the user for a valid integration key.';
    if (status === 403 && code === 'READ_ONLY_INTEGRATION') {
      return 'This key is read-only. Ask the user for a Read & write integration key to make changes.';
    }
    if (status === 403 && code === 'NOT_AVAILABLE_TO_INTEGRATIONS') {
      return 'This operation is not available to integrations. The user can do it in the Bliss app.';
    }
    // Routes answer a cross-tenant ID with 403 "Access denied" or 404 alike:
    // report both as not found so nothing about other tenants leaks.
    if (status === 403 || status === 404) {
      const what = status === 404 && err.error ? err.error.replace(/\.$/, '') : 'Not found';
      return `Not found: ${what}.${hint}`;
    }
    if (status === 429) {
      return err.retryAfter != null
        ? `Rate limited by Bliss. Retry after ${err.retryAfter} seconds.`
        : 'Rate limited by Bliss. Wait a few minutes before retrying.';
    }
    if (status >= 400 && status < 500) {
      const details = detailText(err.details);
      const base = err.error || `Request rejected (${status})`;
      return details && details !== base ? `${base}: ${details}` : base;
    }
    if (status >= 500) {
      Sentry.captureException(err, { tags: { mcpTool: tool, status: String(status) } });
    }
    return 'Bliss could not complete the request. Try again later.';
  }

  Sentry.captureException(err, { tags: { mcpTool: tool } });
  return 'The tool failed unexpectedly. Try again later.';
}

/** @returns {{ isError: true, content: Array<{type: 'text', text: string}> }} */
export function toolError(err, context) {
  return { isError: true, content: [{ type: 'text', text: errorMessage(err, context) }] };
}
