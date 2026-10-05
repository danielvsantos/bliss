/**
 * Integration tests — MCP endpoint protocol, auth and role filtering (#89).
 *
 * AC1  read-only key: initialize + tools/list → exactly the 22 read tools
 * AC2  read & write key → all 41 tools; none uploads files or touches Plaid connections
 * AC3  read-only key calling a write tool → tool error, nothing changes
 * AC4  no key / cookie session / user JWT / revoked / expired key → 401, no tool runs
 * AC14 stateless Streamable HTTP: no Mcp-Session-Id, GET/DELETE → 405
 *
 * A real HTTP server serves every Pages Router handler (helpers/mcpServer.ts),
 * so the SDK client, withAuth, the MCP route, the loopback and the REST
 * handlers all run for real against bliss_test.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const { seenIps } = vi.hoisted(() => ({ seenIps: [] as string[] }));

vi.mock('../../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (req: any, _res: unknown, next: () => void) => {
      seenIps.push(req.headers['x-real-ip']);
      next();
    },
  }),
  createRateLimiter: vi.fn().mockReturnValue((_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock('../../../../utils/produceEvent.js', () => ({ produceEvent: vi.fn().mockResolvedValue(undefined) }));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import prisma from '../../../../prisma/prisma.js';
import { createIsolatedTenant, teardownTenant, type IsolatedTenant } from '../../../helpers/tenant.js';
import { ensureReferenceData } from '../../../helpers/referenceData.js';
import { createIntegrationKey } from '../../../helpers/integration.js';
import { startLoopbackServer, makeFetchStub, type LoopbackServer } from '../../../helpers/mcpServer.js';
import { ALL_TOOLS, READ_TOOLS } from '../../../../lib/mcp/registry.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const SMOKE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/mcp-inspector-smoke.mjs');

let server: LoopbackServer;
let tenant: IsolatedTenant;
let roKey: string;
let rwKey: string;
let transactionId: number;
const realFetch = globalThis.fetch;
const { stub } = makeFetchStub(realFetch, () => server.baseUrl);

async function connect(token: string) {
  const client = new Client({ name: 'bliss-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function rawMcp(headers: Record<string, string>, method = 'POST') {
  return realFetch(`${server.baseUrl}/api/mcp`, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: method === 'POST'
      ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } })
      : undefined,
  });
}

beforeAll(async () => {
  vi.stubGlobal('fetch', stub);
  server = await startLoopbackServer();
  tenant = await createIsolatedTenant('mcp-proto');
  const ref = await ensureReferenceData();
  const category = await prisma.category.create({
    data: { name: 'MCP Groceries', group: 'Food', type: 'Essentials', tenantId: tenant.tenantId },
  });
  const account = await prisma.account.create({
    data: {
      name: 'MCP Checking', accountNumber: '00001234', bankId: ref.bankId, countryId: ref.countryId,
      currencyCode: ref.currencyCode, tenantId: tenant.tenantId,
    },
  });
  const tx = await prisma.transaction.create({
    data: {
      transaction_date: new Date('2026-01-15T00:00:00Z'), year: 2026, month: 1, day: 15, quarter: 'Q1',
      categoryId: category.id, accountId: account.id, description: 'Corner shop', debit: 12.5,
      currency: ref.currencyCode, tenantId: tenant.tenantId,
    },
  });
  transactionId = tx.id;
  roKey = (await createIntegrationKey(tenant, { accessLevel: 'READ_ONLY' })).token;
  rwKey = (await createIntegrationKey(tenant, { accessLevel: 'READ_WRITE' })).token;
});

afterAll(async () => {
  await teardownTenant(tenant.tenantId);
  await server.close();
  vi.unstubAllGlobals();
});

describe('POST /api/mcp — tools/list by role', () => {
  it('AC1: a read-only key sees exactly the 22 read tools, all readOnlyHint', async () => {
    const client = await connect(roKey);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(22);
    expect(tools.map((t) => t.name).sort()).toEqual(READ_TOOLS.map((t) => t.name).sort());
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.map((t) => t.name)).not.toEqual(expect.arrayContaining(['create_bank']));
    expect(tools.map((t) => t.name)).not.toEqual(expect.arrayContaining(['create_account']));
    await client.close();
  });

  it('AC2: a read & write key sees all 41 tools, create_bank / create_account included (#98)', async () => {
    const client = await connect(rwKey);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(41);
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['create_bank', 'create_account']));
    expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS.map((t) => t.name).sort());
    expect(tools.find((t) => t.name === 'delete_transaction')?.annotations?.destructiveHint).toBe(true);
    for (const t of tools) expect(t.inputSchema.type).toBe('object');
    await client.close();
  });

  it('server instructions explain Bliss conventions', async () => {
    const client = await connect(roKey);
    expect(client.getInstructions()).toMatch(/signed/);
    expect(client.getServerVersion()?.name).toBe('bliss');
    await client.close();
  });
});

describe('POST /api/mcp — tool calls', () => {
  it('a read tool returns structured data through the loopback', async () => {
    const client = await connect(roKey);
    const result: any = await client.callTool({ name: 'list_accounts', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.items).toEqual([
      expect.objectContaining({ name: 'MCP Checking', accountNumberLast4: '1234' }),
    ]);
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    await client.close();
  });

  it('forwards the client IP to the REST rate limiters', async () => {
    seenIps.length = 0;
    const client = await connect(roKey);
    await client.callTool({ name: 'list_categories', arguments: {} });
    await client.close();
    expect(seenIps.length).toBeGreaterThan(0);
    expect(seenIps.every((ip) => ip === '127.0.0.1')).toBe(true);
  });

  it('AC3: a read-only key calling a write tool gets an error and nothing changes', async () => {
    const client = await connect(roKey);
    const before = await prisma.transaction.findUnique({ where: { id: transactionId } });
    const result: any = await client.callTool({
      name: 'delete_transaction', arguments: { transactionId },
    }).catch((err: Error) => ({ isError: true, content: [{ text: err.message }] }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found|read-only/i);
    const after = await prisma.transaction.findUnique({ where: { id: transactionId } });
    expect(after).toEqual(before);
    await client.close();
  });

  it('invalid arguments fail input validation before any REST call', async () => {
    const client = await connect(rwKey);
    const result: any = await client.callTool({ name: 'update_subscription', arguments: { action: 'fullScan' } })
      .catch((err: Error) => ({ isError: true, content: [{ text: err.message }] }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/invalid|validation/i);
    await client.close();
  });
});

describe('POST /api/mcp — authentication (AC4)', () => {
  it('no Authorization header → 401', async () => {
    const res = await rawMcp({});
    expect(res.status).toBe(401);
  });

  it('cookie session only → 401', async () => {
    const res = await rawMcp({ cookie: `token=${tenant.token}` });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'INTEGRATION_KEY_REQUIRED' });
  });

  it('user JWT as bearer → 401', async () => {
    const res = await rawMcp({ authorization: `Bearer ${tenant.token}` });
    expect(res.status).toBe(401);
  });

  it('revoked and expired keys → 401', async () => {
    const revoked = await createIntegrationKey(tenant, { accessLevel: 'READ_WRITE', revoked: true });
    const expired = await createIntegrationKey(tenant, { accessLevel: 'READ_WRITE', expiresAt: new Date(Date.now() - 1000) });
    expect((await rawMcp({ authorization: `Bearer ${revoked.token}` })).status).toBe(401);
    expect((await rawMcp({ authorization: `Bearer ${expired.token}` })).status).toBe(401);
  });

  it('a valid key initializes statelessly: no Mcp-Session-Id header', async () => {
    const res = await rawMcp({ authorization: `Bearer ${roKey}` });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe('bliss');
  });

  it('GET and DELETE with a valid key → 405', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await rawMcp({ authorization: `Bearer ${rwKey}` }, method);
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });
});

describe('scripts/mcp-inspector-smoke.mjs (AC14)', () => {
  it('connects, lists and calls list_accounts statelessly', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [SMOKE], {
      env: { ...process.env, BLISS_URL: server.baseUrl, BLISS_API_KEY: roKey },
    });
    expect(stdout).toContain('✓ stateless');
    expect(stdout).toContain('tools/list: 22 tools (22 read, 0 write)');
    expect(stdout).toContain('✓ tools/call list_accounts: 1 account(s)');
    expect(stdout).not.toContain(roKey);
  }, 30_000);
});
