/**
 * Unit tests — MCP core (#89): response shaping, error mapping, the loopback
 * client, the registry and the integration-policy allowance for /api/mcp.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import {
  encodeCursor, decodeCursor, pageArgs, pageMeta, paginate, offsetArgs, offsetMeta, money, signedAmount, isoDate,
  omitDeep, capResponse, clampLimit, num, MAX_RESPONSE_CHARS,
} from '../../../lib/mcp/shape.js';
import { errorMessage, toolError, notFoundAs, ToolInputError, ToolNotFoundError } from '../../../lib/mcp/errors.js';
import {
  LoopbackError, buildQuery, clientIp, createLoopbackClient, loopbackBaseUrl, optional, mapWithConcurrency,
} from '../../../lib/mcp/loopback.js';
import { ALL_TOOLS, READ_TOOLS, toolsForRole, getTool } from '../../../lib/mcp/registry.js';
import { defineTool } from '../../../lib/mcp/define.js';
import { isViewerPostAllowed, VIEWER_POST_ALLOWED } from '../../../utils/integrationPolicy.js';

describe('shape', () => {
  it('round-trips cursors and rejects garbage', () => {
    expect(decodeCursor(encodeCursor({ page: 3 }))).toEqual({ page: 3 });
    expect(decodeCursor(undefined)).toEqual({});
    expect(() => decodeCursor('%%%')).toThrow(ToolInputError);
    expect(() => decodeCursor(encodeCursor({ page: -1 }))).toThrow(/Invalid cursor/);
    expect(() => decodeCursor(Buffer.from('[1]').toString('base64url'))).toThrow(/Invalid cursor/);
  });

  it('clamps limits to 1..100 with a default', () => {
    expect(clampLimit(undefined, 50)).toBe(50);
    expect(clampLimit(500)).toBe(100);
    expect(clampLimit(0)).toBe(1);
  });

  it('page-based meta', () => {
    const p = pageArgs({ cursor: encodeCursor({ page: 2 }), limit: 10 }, 50);
    expect(p).toEqual({ page: 2, limit: 10 });
    expect(pageMeta(p, 25)).toEqual({ hasMore: true, nextCursor: encodeCursor({ page: 3 }) });
    expect(pageMeta(p, 20)).toEqual({ hasMore: false, nextCursor: null });
  });

  it('offset-based meta and in-memory pagination', () => {
    const o = offsetArgs({ limit: 2 }, 50);
    expect(offsetMeta(o, 3)).toEqual({ hasMore: true, nextCursor: encodeCursor({ offset: 2 }) });
    const first = paginate([1, 2, 3], { limit: 2 });
    expect(first).toMatchObject({ items: [1, 2], total: 3, hasMore: true });
    const second = paginate([1, 2, 3], { limit: 2, cursor: first.nextCursor });
    expect(second).toMatchObject({ items: [3], hasMore: false, nextCursor: null });
    expect(paginate(undefined as any, {})).toMatchObject({ items: [], total: 0 });
  });

  it('money, numbers, signs and dates', () => {
    expect(money('12.345', 'EUR')).toEqual({ value: 12.35, currency: 'EUR' });
    expect(money(null, 'EUR')).toBeNull();
    expect(num({ toString: () => '1.5' })).toBe(1.5);
    expect(num('x')).toBeNull();
    expect(signedAmount({ credit: '10', debit: null })).toBe(10);
    expect(signedAmount({ credit: null, debit: '4.5' })).toBe(-4.5);
    expect(signedAmount({})).toBe(0);
    expect(isoDate('2026-03-05T10:00:00Z')).toBe('2026-03-05');
    expect(isoDate('nope')).toBeNull();
  });

  it('omitDeep strips hashes, raw payloads and embeddings at any depth', () => {
    expect(omitDeep({ a: 1, rawJson: 'x', nested: [{ keyHash: 'h', embedding: [1], b: 2 }] })).toEqual({ a: 1, nested: [{ b: 2 }] });
  });

  it('capResponse leaves small results alone and trims + flags large ones without a misleading cursor', () => {
    const small = { items: [1, 2] };
    expect(capResponse(small)).toBe(small);
    const big = { items: Array.from({ length: 1000 }, (_, i) => ({ i, pad: 'x'.repeat(100) })), nextCursor: 'abc' };
    const capped: any = capResponse(big);
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(capped.items.length).toBeLessThan(1000);
    expect(capped.truncated).toBe(true);
    expect(capped.nextCursor).toBeNull();
    expect(big.items).toHaveLength(1000);
  });
});

describe('errors', () => {
  const err = (status: number, extra: Record<string, unknown> = {}) =>
    new LoopbackError({ status, method: 'GET', route: '/api/x', ...extra });

  beforeEach(() => vi.mocked(Sentry.captureException).mockClear());

  it('maps REST statuses to actionable messages', () => {
    expect(errorMessage(err(401))).toMatch(/invalid, expired or revoked/);
    expect(errorMessage(err(403, { code: 'READ_ONLY_INTEGRATION' }))).toMatch(/read-only/);
    expect(errorMessage(err(403, { code: 'NOT_AVAILABLE_TO_INTEGRATIONS' }))).toMatch(/not available to integrations/);
    expect(errorMessage(err(403, { error: 'Access denied' }), { notFoundHint: 'Use x.' })).toBe('Not found: Not found. Use x.');
    expect(errorMessage(err(404, { error: 'Import not found' }), { notFoundHint: 'Use list_imports.' })).toBe('Not found: Import not found. Use list_imports.');
    expect(errorMessage(err(400, { error: 'Bad', details: [{ message: 'x is required' }] }))).toBe('Bad: x is required');
    expect(errorMessage(err(409, { error: 'Conflict', details: 'Conflict' }))).toBe('Conflict');
    expect(errorMessage(err(429, { retryAfter: 30 }))).toMatch(/Retry after 30 seconds/);
    expect(errorMessage(err(429))).toMatch(/Wait a few minutes/);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('reports 5xx and unexpected errors to Sentry with a generic message', () => {
    expect(errorMessage(err(500), { tool: 't' })).toMatch(/could not complete/);
    expect(errorMessage(new Error('boom'), { tool: 't' })).toMatch(/failed unexpectedly/);
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
  });

  it('passes tool-level errors through', () => {
    expect(errorMessage(new ToolInputError('need x'))).toBe('need x');
    expect(errorMessage(new ToolNotFoundError('account 7'), { notFoundHint: 'Use list_accounts.' })).toBe('Not found: account 7. Use list_accounts.');
    expect(toolError(new ToolInputError('need x'), { tool: 't' })).toEqual({ isError: true, content: [{ type: 'text', text: 'need x' }] });
  });

  it('a not-found ID carries the hint of its own kind, not the tool\'s (B8)', async () => {
    const onCategory = new ToolNotFoundError('category 9', 'Use list_categories to find category IDs.');
    expect(errorMessage(onCategory, { notFoundHint: 'Use search_transactions to find transaction IDs.' }))
      .toBe('Not found: category 9. Use list_categories to find category IDs.');
    await expect(notFoundAs(Promise.reject(err(404, { error: 'Income terms not found' })), 'Use get_passive_income.'))
      .rejects.toMatchObject({ message: 'Income terms not found', hint: 'Use get_passive_income.' });
    await expect(notFoundAs(Promise.reject(err(429)), 'x')).rejects.toBeInstanceOf(LoopbackError);
    await expect(notFoundAs(Promise.resolve(5), 'x')).resolves.toBe(5);
  });
});

describe('loopback', () => {
  const req: any = {
    headers: { authorization: 'Bearer bliss_abcdefgh_secret', 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'x-request-id': 'r1', cookie: 'token=jwt' },
    socket: { remoteAddress: '10.0.0.2' },
  };

  function response(status: number, body: unknown, headers: Record<string, string> = {}) {
    return {
      status,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    };
  }

  beforeEach(() => {
    delete process.env.MCP_LOOPBACK_URL;
    delete process.env.PORT;
  });

  it('resolves the base URL from MCP_LOOPBACK_URL or PORT', () => {
    expect(loopbackBaseUrl()).toBe('http://127.0.0.1:3000');
    process.env.PORT = '8080';
    expect(loopbackBaseUrl()).toBe('http://127.0.0.1:8080');
    process.env.MCP_LOOPBACK_URL = 'https://api.example.com/';
    expect(loopbackBaseUrl()).toBe('https://api.example.com');
  });

  it('builds query strings with repeated keys and no empty values', () => {
    expect(buildQuery({ a: 1, b: undefined, c: '', d: null, years: [2025, 2026] })).toBe('a=1&years=2025&years=2026');
  });

  it('uses the same client IP expression as the rate limiters', () => {
    expect(clientIp(req)).toBe('203.0.113.9');
    expect(clientIp({ headers: { 'x-real-ip': '198.51.100.1' } })).toBe('198.51.100.1');
    expect(clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.3' } })).toBe('10.0.0.3');
  });

  it('forwards the key, client IP, request id and tool name — never cookies', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { ok: true }));
    const api = createLoopbackClient({ req, tool: 'list_accounts', fetchImpl });
    await expect(api.post('/api/tags', { name: 'x' }, { id: 3 })).resolves.toEqual({ ok: true });
    const [url, init, timeout] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3000/api/tags?id=3');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"name":"x"}');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer bliss_abcdefgh_secret', 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9',
      'x-bliss-mcp-tool': 'list_accounts', 'x-request-id': 'r1', 'content-type': 'application/json',
    });
    expect(init.headers.cookie).toBeUndefined();
    expect(timeout).toBe(30_000);
    expect(api.calls).toEqual([expect.objectContaining({ method: 'POST', route: '/api/tags', status: 200 })]);
  });

  it('handles empty 204 bodies and throws LoopbackError on non-2xx', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(204, undefined))
      .mockResolvedValueOnce(response(429, { error: 'Too many', retryAfter: 12 }))
      .mockResolvedValueOnce(response(429, { error: 'Too many' }, { 'retry-after': '40' }))
      .mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      .mockResolvedValueOnce({ status: 500, text: async () => 'not json', headers: { get: () => null } });
    const api = createLoopbackClient({ req, tool: 't', fetchImpl });
    await expect(api.del('/api/tags', { id: 1 })).resolves.toBeNull();
    await expect(api.get('/api/x')).rejects.toMatchObject({ status: 429, retryAfter: 12, error: 'Too many' });
    await expect(api.get('/api/x')).rejects.toMatchObject({ status: 429, retryAfter: 40 });
    await expect(api.get('/api/x')).rejects.toMatchObject({ status: 0, error: 'Bliss did not answer in time' });
    await expect(api.put('/api/x', {})).rejects.toMatchObject({ status: 500, error: undefined });
    expect(api.calls.map((c) => c.status)).toEqual([204, 429, 429, 0, 500]);
  });

  it('optional() turns a 404 into the fallback only', async () => {
    await expect(optional(Promise.reject(new LoopbackError({ status: 404, method: 'GET', route: '/x' })), 'fb')).resolves.toBe('fb');
    await expect(optional(Promise.reject(new LoopbackError({ status: 500, method: 'GET', route: '/x' })))).rejects.toMatchObject({ status: 500 });
  });

  it('mapWithConcurrency keeps order and bounds concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(2);
  });
});

describe('registry', () => {
  it('has 38 tools: 21 read, 17 write, unique names', () => {
    expect(ALL_TOOLS).toHaveLength(38);
    expect(READ_TOOLS).toHaveLength(21);
    expect(new Set(ALL_TOOLS.map((t) => t.name)).size).toBe(38);
  });

  it('filters by role: viewer → read tools, member → all', () => {
    expect(toolsForRole('viewer')).toBe(READ_TOOLS);
    expect(toolsForRole('member')).toBe(ALL_TOOLS);
    expect(toolsForRole(undefined as any)).toBe(READ_TOOLS);
    expect(toolsForRole('admin')).toBe(READ_TOOLS);
  });

  it('annotates read and write tools', () => {
    for (const t of ALL_TOOLS) {
      expect(t.annotations.readOnlyHint).toBe(t.access === 'read');
      expect(t.description.length).toBeGreaterThan(40);
      if (t.access === 'read') expect(t.wraps.every((w: any) => w.method === 'GET')).toBe(true);
    }
    expect(getTool('delete_transaction')!.annotations.destructiveHint).toBe(true);
    expect(getTool('create_transaction')!.annotations.destructiveHint).toBe(false);
    expect(getTool('nope')).toBeNull();
  });

  it('defineTool rejects malformed definitions', () => {
    const base = { name: 'ok_tool', access: 'read', title: 'T', description: 'D', input: {}, wraps: [{ method: 'GET', route: '/api/x' }], handler: () => ({}) };
    expect(() => defineTool({ ...base, name: 'Bad-Name' })).toThrow(/Invalid tool name/);
    expect(() => defineTool({ ...base, access: 'admin' })).toThrow(/access/);
    expect(() => defineTool({ ...base, wraps: [] })).toThrow(/wraps/);
    expect(() => defineTool({ ...base, wraps: [{ method: 'POST', route: '/api/x' }] })).toThrow(/read tool/);
    expect(() => defineTool({ ...base, wraps: [{ method: 'GET', route: 'x' }] })).toThrow(/invalid wrap/);
    expect(() => defineTool({ ...base, handler: undefined })).toThrow(/handler/);
    expect(() => defineTool({ ...base, title: '' })).toThrow(/title/);
    expect(() => defineTool({ ...base, input: undefined })).toThrow(/input/);
  });
});

describe('integration policy: /api/mcp viewer POST allowance', () => {
  it('allows POST to the exact MCP path only', () => {
    expect(VIEWER_POST_ALLOWED).toEqual(['/api/mcp']);
    expect(isViewerPostAllowed('/api/mcp', 'POST')).toBe(true);
    expect(isViewerPostAllowed('/api/MCP/?x=1', 'post')).toBe(true);
    expect(isViewerPostAllowed('/api/mcp', 'PUT')).toBe(false);
    expect(isViewerPostAllowed('/api/mcp/tools', 'POST')).toBe(false);
    expect(isViewerPostAllowed('/api/mcpx', 'POST')).toBe(false);
    expect(isViewerPostAllowed('/api/transactions', 'POST')).toBe(false);
    expect(isViewerPostAllowed('/api/mcp/../transactions', 'POST')).toBe(false);
    expect(isViewerPostAllowed(undefined as any, undefined as any)).toBe(false);
  });
});
