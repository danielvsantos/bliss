/**
 * Unit tests — #84 utility changes made for MCP (#89) and the tool wrapper:
 *   - withAuth lets a read-only key POST to /api/mcp only (exact path)
 *   - the integration_request line carries a sanitised `mcpTool`
 *   - wrapTool logs one mcp_tool_call line and maps failures to tool errors
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: { apiKey: { findUnique: vi.fn(), updateMany: vi.fn() }, user: { findUnique: vi.fn() } },
}));
vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));
vi.mock('../../../utils/denylist.js', () => ({ isRevoked: vi.fn().mockResolvedValue(false) }));
vi.mock('../../../utils/cors.js', () => ({ cors: vi.fn().mockReturnValue(false) }));

import { withAuth } from '../../../utils/withAuth.js';
import { generateApiKey, _resetLastUsedThrottle } from '../../../utils/apiKeys.js';
import { wrapTool } from '../../../lib/mcp/server.js';
import { defineTool } from '../../../lib/mcp/define.js';
import { ToolInputError } from '../../../lib/mcp/errors.js';

function arrangeKey(accessLevel: 'READ_ONLY' | 'READ_WRITE') {
  const { token, prefix, keyHash } = generateApiKey();
  mockPrisma.apiKey.findUnique.mockResolvedValue({
    id: 'key-1', tenantId: 't-1', integrationId: 'int-1', prefix, keyHash, expiresAt: null, revokedAt: null,
    integration: { id: 'int-1', tenantId: 't-1', accessLevel, createdByUserId: 'u-1', revokedAt: null },
  });
  mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', tenantId: 't-1', email: 'a@x', role: 'admin' });
  return token;
}

function makeRes() {
  const res: any = { statusCode: 200 };
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; });
  res.json = vi.fn((b: unknown) => { res.body = b; return res; });
  return res;
}

async function call(url: string, method: string, headers: Record<string, string>) {
  const handler = vi.fn((_req: any, res: any) => res.status(200).json({ ok: true }));
  const res = makeRes();
  await withAuth(handler)({ url, method, headers, cookies: {} } as any, res);
  return { res, handler };
}

function loggedLines(spy: any) {
  return spy.mock.calls.map(([l]: any[]) => { try { return JSON.parse(String(l)); } catch { return null; } }).filter(Boolean);
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetLastUsedThrottle();
  mockPrisma.apiKey.updateMany.mockResolvedValue({ count: 1 });
});

describe('withAuth — read-only keys and /api/mcp', () => {
  it('lets a read-only key POST to /api/mcp and nowhere else', async () => {
    const token = arrangeKey('READ_ONLY');
    const auth = { authorization: `Bearer ${token}` };
    expect((await call('/api/mcp', 'POST', auth)).res.statusCode).toBe(200);
    expect((await call('/api/mcp/', 'POST', auth)).res.statusCode).toBe(200);
    for (const [url, method] of [['/api/mcp', 'PUT'], ['/api/mcp/x', 'POST'], ['/api/transactions', 'POST'], ['/api/mcpx', 'POST']]) {
      const { res, handler } = await call(url, method, auth);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.body.code).toBe('READ_ONLY_INTEGRATION');
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it('JWT viewers are unaffected (no allowance outside the integration path)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-2', tenantId: 't-1', email: 'v@x', role: 'viewer' });
    const jwt = (await import('jsonwebtoken')).default;
    const token = jwt.sign({ userId: 'u-2', tenantId: 't-1' }, process.env.JWT_SECRET_CURRENT!);
    const { res } = await call('/api/mcp', 'POST', { authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(403);
  });
});

describe('withAuth — mcpTool attribution', () => {
  it('logs a well-formed x-bliss-mcp-tool and drops anything else', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const token = arrangeKey('READ_WRITE');
    await call('/api/transactions', 'GET', { authorization: `Bearer ${token}`, 'x-bliss-mcp-tool': 'search_transactions' });
    await call('/api/transactions', 'GET', { authorization: `Bearer ${token}`, 'x-bliss-mcp-tool': 'Bad Tool"}' });
    await call('/api/transactions', 'GET', { authorization: `Bearer ${token}` });
    const lines = loggedLines(spy).filter((l: any) => l.event === 'integration_request');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ mcpTool: 'search_transactions', integrationId: 'int-1', apiKeyId: 'key-1' });
    expect(lines[1].mcpTool).toBeUndefined();
    expect(lines[2].mcpTool).toBeUndefined();
    spy.mockRestore();
  });
});

describe('wrapTool', () => {
  const req: any = { headers: { authorization: 'Bearer bliss_x' }, user: { tenantId: 't-1', integrationId: 'int-1', apiKeyId: 'key-1' } };
  const base = { access: 'read', title: 'T', description: 'D', input: {}, wraps: [{ method: 'GET', route: '/api/x' }] };

  it('returns text + structuredContent, strips hidden keys and logs one line', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const tool = defineTool({ ...base, name: 'demo_tool', handler: async () => ({ items: [{ id: 1, rawJson: 'x' }] }) });
    const result: any = await wrapTool(tool, req)({});
    expect(result.structuredContent).toEqual({ items: [{ id: 1 }] });
    expect(JSON.parse(result.content[0].text)).toEqual({ items: [{ id: 1 }] });
    expect(loggedLines(spy)).toEqual([expect.objectContaining({
      event: 'mcp_tool_call', tool: 'demo_tool', ok: true, tenantId: 't-1', integrationId: 'int-1', apiKeyId: 'key-1', calls: [],
    })]);
    spy.mockRestore();
  });

  it('maps a thrown error to an isError result and logs ok: false', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const tool = defineTool({ ...base, name: 'bad_tool', handler: async () => { throw new ToolInputError('need x'); } });
    const result: any = await wrapTool(tool, req)(undefined);
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'need x' }] });
    expect(loggedLines(spy)[0]).toMatchObject({ tool: 'bad_tool', ok: false });
    spy.mockRestore();
  });
});
