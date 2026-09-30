import { z } from 'zod';
import { MAX_LIMIT } from './shape.js';

/**
 * Tool definition helper (#89).
 *
 * A tool is `{ name, access, title, description, input, wraps, handler }`:
 *   - `access`   'read' (every key) or 'write' (Read & write keys only)
 *   - `input`    zod raw shape (the MCP SDK turns it into the JSON Schema)
 *   - `wraps`    the REST operations the tool calls — the coverage test holds
 *                every reachable route to "wrapped by a tool or excluded"
 *   - `handler`  async (args, { api }) → plain JSON object
 */

const NAME = /^[a-z][a-z_]{2,63}$/;

export function defineTool(def) {
  const { name, access, title, description, input, wraps, handler } = def;
  if (!NAME.test(name)) throw new Error(`Invalid tool name: ${name}`);
  if (access !== 'read' && access !== 'write') throw new Error(`${name}: access must be read|write`);
  if (!title || !description) throw new Error(`${name}: title and description are required`);
  if (!input || typeof input !== 'object') throw new Error(`${name}: input shape is required`);
  if (!Array.isArray(wraps) || wraps.length === 0) throw new Error(`${name}: wraps is required`);
  for (const w of wraps) {
    if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(w.method) || !w.route?.startsWith('/api/')) {
      throw new Error(`${name}: invalid wrap ${JSON.stringify(w)}`);
    }
    if (access === 'read' && w.method !== 'GET') throw new Error(`${name}: a read tool can only wrap GET routes`);
  }
  if (typeof handler !== 'function') throw new Error(`${name}: handler is required`);

  const annotations = access === 'read'
    ? { title, readOnlyHint: true, openWorldHint: false }
    : { title, readOnlyHint: false, destructiveHint: def.destructive === true, openWorldHint: false };

  return Object.freeze({ ...def, annotations, notFoundHint: def.notFoundHint ?? null });
}

// ── Shared input fields ───────────────────────────────────────────────────────

export const dateString = (what = 'Date') =>
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').describe(`${what} (YYYY-MM-DD)`);

export const cursorField = z.string().max(500).optional()
  .describe('Opaque cursor from a previous result\'s nextCursor. Omit for the first page.');

export const limitField = (fallback) => z.number().int().min(1).max(MAX_LIMIT).optional()
  .describe(`Items per page (1-${MAX_LIMIT}, default ${fallback}).`);

export const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter uppercase ISO code, e.g. EUR');

export const intId = (what) => z.number().int().positive().describe(what);
/** IDs that end up in a URL path: cuid / hash characters only (no `/`, `.`, `%`). */
export const pathId = () => z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, 'Invalid ID');
export const stringId = (what) => pathId().describe(what);
