/**
 * Integration tests — MCP headline workflows end to end (#89).
 *
 * AC5  update_transaction ≡ PUT /api/transactions (same DB state, events,
 *      feedback call) and the attribution log carries mcpTool
 * AC7  Plaid review queue (item approve + bulkPromote) and staged imports
 *      (review_import_rows → finalize_import commit / cancel) leave their queues
 * AC8  manage_manual_values add → visible in get_holding_details, revaluation event fired
 * AC9  update_subscription merge / unmerge behave like the REST actions
 * #98  create_bank / create_account set up a workspace: idempotent, duplicate-
 *      safe, visible to list_accounts and create_transaction, account number
 *      never echoed or logged
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
  createRateLimiter: vi.fn().mockReturnValue((_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock('../../../../utils/produceEvent.js', () => ({ produceEvent: vi.fn().mockResolvedValue(undefined) }));

import prisma from '../../../../prisma/prisma.js';
import { produceEvent } from '../../../../utils/produceEvent.js';
import { createIsolatedTenant, teardownTenant, type IsolatedTenant } from '../../../helpers/tenant.js';
import { ensureReferenceData } from '../../../helpers/referenceData.js';
import { createIntegrationKey } from '../../../helpers/integration.js';
import { startLoopbackServer, makeFetchStub, connectMcp, callTool, type LoopbackServer } from '../../../helpers/mcpServer.js';

let server: LoopbackServer;
const realFetch = globalThis.fetch;
const { stub, backendCalls } = makeFetchStub(realFetch, () => server.baseUrl);

interface Seeded {
  tenant: IsolatedTenant;
  key: string;
  accountId: number;
  groceries: number;
  dining: number;
  transactionId: number;
}

let seq = 0;
async function seedTenant(label: string): Promise<Seeded> {
  seq += 1;
  const tenant = await createIsolatedTenant(`mcp-wf-${label}`);
  const ref = await ensureReferenceData();
  const groceries = await prisma.category.create({ data: { name: 'Groceries', group: 'Food', type: 'Essentials', tenantId: tenant.tenantId } });
  const dining = await prisma.category.create({ data: { name: 'Dining', group: 'Food', type: 'Lifestyle', tenantId: tenant.tenantId } });
  const account = await prisma.account.create({
    data: {
      name: `Checking ${label}`, accountNumber: `0000${seq}`, bankId: ref.bankId, countryId: ref.countryId,
      currencyCode: ref.currencyCode, tenantId: tenant.tenantId, plaidAccountId: `mcp-plaid-${label}-${Date.now()}`,
    },
  });
  const tx = await prisma.transaction.create({
    data: {
      transaction_date: new Date('2026-02-10T00:00:00Z'), year: 2026, month: 2, day: 10, quarter: 'Q1',
      categoryId: groceries.id, accountId: account.id, description: 'Bistro Central', debit: 30,
      currency: 'USD', tenantId: tenant.tenantId,
    },
  });
  const key = (await createIntegrationKey(tenant, { accessLevel: 'READ_WRITE' })).token;
  return { tenant, key, accountId: account.id, groceries: groceries.id, dining: dining.id, transactionId: tx.id };
}

let a: Seeded;
let b: Seeded;

beforeAll(async () => {
  vi.stubGlobal('fetch', stub);
  server = await startLoopbackServer();
  a = await seedTenant('a');
  b = await seedTenant('b');
});

afterAll(async () => {
  await teardownTenant(a.tenant.tenantId);
  await teardownTenant(b.tenant.tenantId);
  await server.close();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.mocked(produceEvent).mockClear();
  backendCalls.length = 0;
});

function eventShapes() {
  return vi.mocked(produceEvent).mock.calls.map(([e]: any[]) => ({ type: e.type, keys: Object.keys(e).sort() }));
}

describe('AC5 — update_transaction is identical to PUT /api/transactions', () => {
  it('produces the same DB state, events and classifier feedback', async () => {
    // Tenant B: the app's REST call with a user JWT (the edit form sends the full record).
    const restRes = await realFetch(`${server.baseUrl}/api/transactions?id=${b.transactionId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${b.tenant.token}` },
      body: JSON.stringify({
        transaction_date: '2026-02-10', accountId: b.accountId, categoryId: b.dining, description: 'Bistro Central',
        debit: 30, currency: 'USD',
      }),
    });
    expect(restRes.status).toBe(200);
    const restEvents = eventShapes();
    const restFeedback = backendCalls.filter((c) => c.url.includes('/api/feedback')).map((c) => ({ ...c.body, tenantId: 'T' }));

    vi.mocked(produceEvent).mockClear();
    backendCalls.length = 0;
    const logSpy = vi.spyOn(console, 'info');

    // Tenant A: the same change through MCP.
    const client = await connectMcp(server.baseUrl, a.key);
    const result = await callTool(client, 'update_transaction', { transactionId: a.transactionId, categoryId: a.dining });
    await client.close();
    expect(result.isError).toBe(false);
    expect(result.data.updated.category).toMatchObject({ id: a.dining, name: 'Dining' });

    const [rowA, rowB] = await Promise.all([
      prisma.transaction.findUnique({ where: { id: a.transactionId } }),
      prisma.transaction.findUnique({ where: { id: b.transactionId } }),
    ]);
    for (const field of ['description', 'debit', 'credit', 'currency', 'transaction_date', 'details', 'ticker'] as const) {
      expect(String(rowA![field])).toBe(String(rowB![field]));
    }
    expect(rowA!.categoryId).toBe(a.dining);
    expect(rowB!.categoryId).toBe(b.dining);

    expect(eventShapes()).toEqual(restEvents);
    const mcpFeedback = backendCalls.filter((c) => c.url.includes('/api/feedback')).map((c) => ({ ...c.body, tenantId: 'T' }));
    expect(mcpFeedback.map((f) => ({ ...f, categoryId: 0 }))).toEqual(restFeedback.map((f) => ({ ...f, categoryId: 0 })));
    expect(mcpFeedback).toHaveLength(1);

    const lines = logSpy.mock.calls.map(([l]) => { try { return JSON.parse(String(l)); } catch { return null; } }).filter(Boolean);
    expect(lines).toContainEqual(expect.objectContaining({
      event: 'integration_request', method: 'PUT', route: '/api/transactions', mcpTool: 'update_transaction',
      integrationId: expect.any(String), tenantId: a.tenant.tenantId,
    }));
    expect(lines).toContainEqual(expect.objectContaining({
      event: 'mcp_tool_call', tool: 'update_transaction', ok: true, tenantId: a.tenant.tenantId,
    }));
    logSpy.mockRestore();
  });
});

describe('AC7 — review queues', () => {
  it('Plaid: approve one item and bulk-promote the ≥0.9 ones; they leave the queue', async () => {
    const item = await prisma.plaidItem.create({
      data: { tenantId: a.tenant.tenantId, userId: a.tenant.userId, itemId: `mcp-item-${Date.now()}`, accessToken: 'access-sandbox-test' },
    });
    const account = await prisma.account.findUnique({ where: { id: a.accountId } });
    await prisma.account.update({ where: { id: a.accountId }, data: { plaidItemId: item.id } });
    const mk = (n: number, confidence: number) => prisma.plaidTransaction.create({
      data: {
        plaidItemId: item.id, plaidAccountId: account!.plaidAccountId!, plaidTransactionId: `mcp-ptx-${Date.now()}-${n}`,
        amount: 10 + n, date: new Date('2026-03-0' + n + 'T00:00:00Z'), name: `SHOP ${n}`, isoCurrencyCode: 'USD',
        suggestedCategoryId: a.groceries, aiConfidence: confidence, promotionStatus: 'CLASSIFIED',
      },
    });
    const low = await mk(1, 0.5);
    const high1 = await mk(2, 0.95);
    const high2 = await mk(3, 0.92);

    const client = await connectMcp(server.baseUrl, a.key);
    const queue = await callTool(client, 'get_plaid_review_queue', {});
    expect(queue.data.items.map((i: any) => i.id).sort()).toEqual([low.id, high1.id, high2.id].sort());
    expect(queue.data.items.find((i: any) => i.id === low.id).amount).toEqual({ value: -11, currency: 'USD' });

    const reviewed = await callTool(client, 'review_plaid_transactions', { items: [{ id: low.id, action: 'approve', categoryId: a.dining }] });
    expect(reviewed.data).toMatchObject({ succeeded: 1, failed: 0 });
    const bulk = await callTool(client, 'review_plaid_transactions', { bulkPromote: { minConfidence: 0.9 } });
    expect(bulk.data.promoted).toBe(2);

    const after = await callTool(client, 'get_plaid_review_queue', {});
    expect(after.data.items).toEqual([]);
    await client.close();

    const rows = await prisma.plaidTransaction.findMany({ where: { id: { in: [low.id, high1.id, high2.id] } } });
    expect(rows.every((r) => r.promotionStatus === 'PROMOTED' && r.matchedTransactionId != null)).toBe(true);
    const created = await prisma.transaction.findUnique({ where: { id: rows.find((r) => r.id === low.id)!.matchedTransactionId! } });
    expect(created!.categoryId).toBe(a.dining);
  });

  it('Imports: review rows, commit, and cancel another import', async () => {
    const mkImport = async (name: string) => prisma.stagedImport.create({
      data: {
        tenantId: a.tenant.tenantId, userId: 'user@test', accountId: a.accountId, status: 'READY', fileName: name, totalRows: 2, progress: 100,
        rows: {
          create: [
            { rowNumber: 1, rawData: {}, transactionDate: new Date('2026-04-01T00:00:00Z'), description: 'MARKET', debit: 20, currency: 'USD', accountId: a.accountId, suggestedCategoryId: a.groceries, confidence: 0.8, status: 'PENDING' },
            { rowNumber: 2, rawData: {}, transactionDate: new Date('2026-04-02T00:00:00Z'), description: 'CAFE', debit: 5, currency: 'USD', accountId: a.accountId, status: 'PENDING' },
          ],
        },
      },
      include: { rows: true },
    });
    const commitMe = await mkImport('april.csv');
    const cancelMe = await mkImport('dupe.csv');

    const client = await connectMcp(server.baseUrl, a.key);
    const pending = await callTool(client, 'list_imports', {});
    expect(pending.data.items.map((i: any) => i.importId)).toEqual(expect.arrayContaining([commitMe.id, cancelMe.id]));

    const detail = await callTool(client, 'list_imports', { importId: commitMe.id, uncategorized: true });
    expect(detail.data.rows).toHaveLength(1);
    const cafe = detail.data.rows[0];
    expect(cafe).toMatchObject({ description: 'CAFE', amount: { value: -5, currency: 'USD' } });

    const reviewed = await callTool(client, 'review_import_rows', {
      importId: commitMe.id, rows: [{ rowId: cafe.rowId, categoryId: a.dining, status: 'CONFIRMED' }],
    });
    expect(reviewed.data.succeeded).toBe(1);
    const bulk = await callTool(client, 'review_import_rows', { importId: commitMe.id, bulkConfirm: { categoryId: a.groceries } });
    expect(bulk.data.confirmed).toBe(1);

    const commit = await callTool(client, 'finalize_import', { importId: commitMe.id, action: 'commit' });
    expect(commit.data.status).toBe('COMMITTING');
    expect(vi.mocked(produceEvent)).toHaveBeenCalledWith(expect.objectContaining({ type: 'SMART_IMPORT_COMMIT', stagedImportId: commitMe.id }));

    const cancel = await callTool(client, 'finalize_import', { importId: cancelMe.id, action: 'cancel' });
    expect(cancel.data.status).toBe('CANCELLED');

    const after = await callTool(client, 'list_imports', {});
    const ids = after.data.items.map((i: any) => i.importId);
    expect(ids).not.toContain(commitMe.id);
    expect(ids).not.toContain(cancelMe.id);
    await client.close();

    const rows = await prisma.stagedImportRow.findMany({ where: { stagedImportId: commitMe.id } });
    expect(rows.every((r) => r.status === 'CONFIRMED')).toBe(true);
    expect((await prisma.stagedImport.findUnique({ where: { id: cancelMe.id } }))!.status).toBe('CANCELLED');
  });
});

describe('AC8 — manual values', () => {
  it('add → appears in get_holding_details and fires the revaluation event', async () => {
    const category = await prisma.category.create({
      data: { name: 'Real Estate', group: 'Property', type: 'Asset', processingHint: 'MANUAL', tenantId: a.tenant.tenantId },
    });
    const asset = await prisma.portfolioItem.create({
      data: { tenantId: a.tenant.tenantId, categoryId: category.id, symbol: 'Real Estate:Flat', currency: 'USD', source: 'MANUAL', quantity: 2 },
    });

    const client = await connectMcp(server.baseUrl, a.key);
    const holdings = await callTool(client, 'get_portfolio_holdings', {});
    expect(holdings.data.items.map((i: any) => i.assetId)).toContain(asset.id);

    const added = await callTool(client, 'manage_manual_values', {
      assetId: asset.id, action: 'add', date: '2026-05-01', value: 250000, currency: 'USD',
    });
    expect(added.isError).toBe(false);
    // value is a per-unit price: the tool echoes the quantity and the total it implies.
    expect(added.data.added).toMatchObject({ currentQuantity: 2, impliedMarketValue: { value: 500000, currency: 'USD' } });
    expect(vi.mocked(produceEvent)).toHaveBeenCalledWith(expect.objectContaining({
      type: 'MANUAL_PORTFOLIO_PRICE_UPDATED', portfolioItemId: asset.id, tenantId: a.tenant.tenantId,
    }));

    const details = await callTool(client, 'get_holding_details', { assetId: asset.id });
    expect(details.data.manualValues).toEqual([
      expect.objectContaining({ valueId: added.data.added.valueId, date: '2026-05-01', value: { value: 250000, currency: 'USD' } }),
    ]);
    expect(details.data.debtTerms).toBeNull();

    const removed = await callTool(client, 'manage_manual_values', { assetId: asset.id, action: 'delete', valueId: added.data.added.valueId });
    expect(removed.data.deleted).toBe(added.data.added.valueId);
    await client.close();
  });
});

describe('AC9 — subscriptions', () => {
  it('rejects fullScan and merges / unmerges like the REST actions', async () => {
    const mk = (hash: string, label: string) => prisma.recurringCharge.create({
      data: {
        tenantId: a.tenant.tenantId, descriptionHash: hash, merchantLabel: label, categoryId: a.dining,
        cadence: 'MONTHLY', amount: 9.99, currency: 'USD', occurrenceCount: 3, chargeKey: `key-${hash}`,
        lastChargedAt: new Date(),
      },
    });
    await mk('hash-netflix-1', 'NETFLIX.COM');
    await mk('hash-netflix-2', 'Netflix');

    const client = await connectMcp(server.baseUrl, a.key);
    const full = await callTool(client, 'update_subscription', { action: 'fullScan' });
    expect(full.isError).toBe(true);
    expect(vi.mocked(produceEvent)).not.toHaveBeenCalled();

    const list = await callTool(client, 'list_subscriptions', { view: 'all' });
    expect(list.data.items.map((s: any) => s.subscriptionId)).toEqual(expect.arrayContaining(['hash-netflix-1', 'hash-netflix-2']));

    const merged = await callTool(client, 'update_subscription', {
      action: 'merge', subscriptionId: 'hash-netflix-1', targetSubscriptionId: 'hash-netflix-2',
    });
    expect(merged.data).toMatchObject({ merged: 1, mergedIntoHash: 'hash-netflix-2' });
    let row = await prisma.recurringCharge.findFirst({ where: { tenantId: a.tenant.tenantId, descriptionHash: 'hash-netflix-1' } });
    expect(row).toMatchObject({ mergedIntoHash: 'hash-netflix-2', chargeKey: 'key-hash-netflix-2' });

    const unmerged = await callTool(client, 'update_subscription', { action: 'unmerge', subscriptionId: 'hash-netflix-1' });
    expect(unmerged.data.unmerged).toBe(1);
    row = await prisma.recurringCharge.findFirst({ where: { tenantId: a.tenant.tenantId, descriptionHash: 'hash-netflix-1' } });
    expect(row!.mergedIntoHash).toBeNull();
    await client.close();
  });
});

describe('#98 — set up a workspace with create_bank and create_account', () => {
  const FULL_NUMBER = 'DE89370400440532013000';
  let setup: IsolatedTenant;
  let key: string;
  let categoryId: number;

  beforeAll(async () => {
    setup = await createIsolatedTenant('mcp-wf-setup');
    const ref = await ensureReferenceData();
    await prisma.tenantCurrency.create({ data: { tenantId: setup.tenantId, currencyId: ref.currencyCode, isDefault: true } });
    await prisma.tenantCountry.create({ data: { tenantId: setup.tenantId, countryId: ref.countryId, isDefault: true } });
    categoryId = (await prisma.category.create({ data: { name: 'Groceries', group: 'Food', type: 'Essentials', tenantId: setup.tenantId } })).id;
    key = (await createIntegrationKey(setup, { accessLevel: 'READ_WRITE' })).token;
  });

  afterAll(async () => {
    // TenantBank/TenantCurrency/TenantCountry and AccountOwner do not cascade.
    await prisma.transaction.deleteMany({ where: { tenantId: setup.tenantId } });
    await prisma.accountOwner.deleteMany({ where: { account: { tenantId: setup.tenantId } } });
    await prisma.account.deleteMany({ where: { tenantId: setup.tenantId } });
    await prisma.tenantBank.deleteMany({ where: { tenantId: setup.tenantId } });
    await prisma.tenantCurrency.deleteMany({ where: { tenantId: setup.tenantId } });
    await prisma.tenantCountry.deleteMany({ where: { tenantId: setup.tenantId } });
    await teardownTenant(setup.tenantId);
  });

  it('creates a bank and an account idempotently, usable like one made in the app', async () => {
    const ref = await ensureReferenceData();
    const bankName = `MCP Setup Bank ${Date.now()}`;
    const logSpy = vi.spyOn(console, 'info');
    const client = await connectMcp(server.baseUrl, key);

    const first = await callTool(client, 'create_bank', { name: bankName });
    expect(first.isError, first.text).toBe(false);
    expect(first.data).toEqual({ id: expect.any(Number), name: bankName, created: true });
    const again = await callTool(client, 'create_bank', { name: bankName.toUpperCase() });
    expect(again.data).toEqual({ id: first.data.id, name: bankName, created: false });
    expect(await prisma.tenantBank.count({ where: { tenantId: setup.tenantId, bankId: first.data.id } })).toBe(1);
    expect(await prisma.bank.count({ where: { name: { equals: bankName, mode: 'insensitive' } } })).toBe(1);

    const accountArgs = {
      name: 'Main EUR', bankId: first.data.id, currencyCode: ref.currencyCode, countryId: ref.countryId, accountNumber: FULL_NUMBER,
    };
    const created = await callTool(client, 'create_account', accountArgs);
    expect(created.isError, created.text).toBe(false);
    expect(created.data.account).toMatchObject({
      id: expect.any(Number), name: 'Main EUR', bankId: first.data.id, bank: bankName, currency: ref.currencyCode,
      accountNumberLast4: '3000', linkedToPlaid: false,
    });
    const accountId = created.data.account.id;

    // Same bank + currency + name (any casing) → one-line duplicate error with the id, no second row.
    const duplicate = await callTool(client, 'create_account', { ...accountArgs, name: ' main eur ' });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.text).toContain(`already exists (id ${accountId})`);
    expect(await prisma.account.count({ where: { tenantId: setup.tenantId } })).toBe(1);

    // Stored like a UI account: encrypted number round-trips, owner defaults to the connecting admin.
    const row = await prisma.account.findUnique({ where: { id: accountId }, include: { owners: true } });
    expect(row!.accountNumber).toBe(FULL_NUMBER);
    expect(row!.owners.map((o) => o.userId)).toEqual([setup.userId]);

    const listed = await callTool(client, 'list_accounts', {});
    expect(listed.data.items.map((a: any) => a.id)).toContain(accountId);

    const tx = await callTool(client, 'create_transaction', {
      date: '2026-03-01', accountId, categoryId, description: 'Corner shop', amount: -12.5, currency: ref.currencyCode,
    });
    expect(tx.isError, tx.text).toBe(false);

    const notEnabled = await callTool(client, 'create_account', { ...accountArgs, name: 'Swiss', currencyCode: 'CHF' });
    expect(notEnabled.isError).toBe(true);
    expect(notEnabled.text).toBe('Currency CHF isn\'t enabled for this workspace — ask the user to enable it in Settings → Currencies.');

    await client.close();

    const logged = logSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
    expect(logged).toContain('"tool":"create_account"');
    expect(logged).not.toContain(FULL_NUMBER);
    for (const r of [first, again, created, duplicate, listed]) expect(r.text).not.toContain(FULL_NUMBER);
    logSpy.mockRestore();
  });
});
