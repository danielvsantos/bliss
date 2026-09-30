/**
 * Integration tests — MCP response bounds (#89, AC11).
 *
 * 5,000 matching transactions: search_transactions returns at most the
 * default page (50), hasMore + nextCursor, stays under the ~25k character
 * target, and following the cursor gives the next page with no overlap.
 *
 * Each row has its own date: GET /api/transactions orders by date only, so
 * same-day rows have no stable order across pages (a REST-side limitation).
 *
 * Rows are inserted with raw SQL and one shared ciphertext: every encrypted
 * field has its own PBKDF2-derived key, so 5,000 Prisma creates would take
 * minutes. Reads then hit the key cache.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
  createRateLimiter: vi.fn().mockReturnValue((_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock('../../../../utils/produceEvent.js', () => ({ produceEvent: vi.fn().mockResolvedValue(undefined) }));

import prisma from '../../../../prisma/prisma.js';
import { encrypt } from '../../../../utils/encryption.js';
import { createIsolatedTenant, teardownTenant, type IsolatedTenant } from '../../../helpers/tenant.js';
import { ensureReferenceData } from '../../../helpers/referenceData.js';
import { createIntegrationKey } from '../../../helpers/integration.js';
import { startLoopbackServer, makeFetchStub, connectMcp, callTool, type LoopbackServer } from '../../../helpers/mcpServer.js';
import { TARGET_RESPONSE_CHARS, MAX_RESPONSE_CHARS } from '../../../../lib/mcp/shape.js';

const COUNT = 5000;

let server: LoopbackServer;
const realFetch = globalThis.fetch;
const { stub } = makeFetchStub(realFetch, () => server.baseUrl);
let tenant: IsolatedTenant;
let client: any;

beforeAll(async () => {
  vi.stubGlobal('fetch', stub);
  server = await startLoopbackServer();
  tenant = await createIsolatedTenant('mcp-page');
  const ref = await ensureReferenceData();
  const category = await prisma.category.create({ data: { name: 'Bulk', group: 'Misc', type: 'Lifestyle', tenantId: tenant.tenantId } });
  const account = await prisma.account.create({
    data: { name: 'Bulk acct', accountNumber: '42', bankId: ref.bankId, countryId: ref.countryId, currencyCode: ref.currencyCode, tenantId: tenant.tenantId },
  });
  const description = encrypt('Purchase with a fairly long merchant descriptor');
  await prisma.$executeRaw`
    INSERT INTO "Transaction" (transaction_date, year, quarter, month, day, "categoryId", description, currency, "accountId", "tenantId", debit, "updatedAt")
    SELECT d, extract(year FROM d)::int, 'Q' || extract(quarter FROM d)::int, extract(month FROM d)::int, extract(day FROM d)::int,
           ${category.id}, ${description}, 'USD', ${account.id}, ${tenant.tenantId}, 10 + (g % 100), now()
    FROM generate_series(0, ${COUNT - 1}::int) AS g, LATERAL (SELECT (date '2025-12-31' - g) AS d) AS dates`;
  const key = (await createIntegrationKey(tenant, { accessLevel: 'READ_ONLY' })).token;
  client = await connectMcp(server.baseUrl, key);
}, 120_000);

afterAll(async () => {
  await client?.close();
  await teardownTenant(tenant.tenantId);
  await server.close();
  vi.unstubAllGlobals();
});

describe('search_transactions bounds (AC11)', () => {
  it('returns one default page with hasMore, under the size target, and the cursor continues without overlap', async () => {
    const first = await callTool(client, 'search_transactions', { from: '2012-01-01', to: '2025-12-31' });
    expect(first.isError, first.text).toBe(false);
    expect(first.data.items.length).toBeLessThanOrEqual(50);
    expect(first.data.items).toHaveLength(50);
    expect(first.data.total).toBe(COUNT);
    expect(first.data.hasMore).toBe(true);
    expect(first.data.nextCursor).toEqual(expect.any(String));
    expect(first.text.length).toBeLessThan(TARGET_RESPONSE_CHARS);

    const second = await callTool(client, 'search_transactions', { from: '2012-01-01', to: '2025-12-31', cursor: first.data.nextCursor });
    expect(second.data.items).toHaveLength(50);
    const ids = new Set(first.data.items.map((t: any) => t.id));
    expect(second.data.items.some((t: any) => ids.has(t.id))).toBe(false);
  });

  it('caps limit at 100', async () => {
    const res = await callTool(client, 'search_transactions', { limit: 500 });
    expect(res.isError).toBe(true);
    const ok = await callTool(client, 'search_transactions', { limit: 100 });
    expect(ok.data.items).toHaveLength(100);
    expect(ok.data.truncated).toBeUndefined();
    expect(ok.text.length).toBeLessThan(MAX_RESPONSE_CHARS);
  });

  it('rejects a tampered cursor', async () => {
    const res = await callTool(client, 'search_transactions', { cursor: 'not-a-cursor' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Invalid cursor/);
  });
});
