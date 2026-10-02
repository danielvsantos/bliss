/**
 * Integration tests — MCP tenant isolation (#89, AC10).
 *
 * Tenant A's key is used with tenant B's real IDs on every tool that takes an
 * ID. Tools that look an ID up must answer "not found"; tools that only filter
 * by an ID must return nothing of B's. Either way, nothing of tenant B (all its
 * names carry the BSECRET marker) may appear in any result, and B's rows are
 * unchanged. The table is checked against the registry: a new tool with an
 * `*Id` input (or a batch `items`/`rows` input) fails until it is listed here.
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
import { createIsolatedTenant, teardownTenant, type IsolatedTenant } from '../../../helpers/tenant.js';
import { ensureReferenceData } from '../../../helpers/referenceData.js';
import { createIntegrationKey } from '../../../helpers/integration.js';
import { startLoopbackServer, makeFetchStub, connectMcp, callTool, type LoopbackServer } from '../../../helpers/mcpServer.js';
import { ALL_TOOLS } from '../../../../lib/mcp/registry.js';

const MARK = 'BSECRET';

let server: LoopbackServer;
const realFetch = globalThis.fetch;
const { stub } = makeFetchStub(realFetch, () => server.baseUrl);

let a: IsolatedTenant;
let b: IsolatedTenant;
let keyA: string;
let ownA: { transactionId: number; assetId: number; bankId: number };
let B: Record<string, any>;

async function seedB() {
  const ref = await ensureReferenceData();
  const category = await prisma.category.create({ data: { name: `${MARK} cat`, group: 'Food', type: 'Essentials', tenantId: b.tenantId } });
  const incomeCat = await prisma.category.create({ data: { name: `${MARK} allowance`, group: 'Passive Income', type: 'Income', tenantId: b.tenantId } });
  const assetCat = await prisma.category.create({ data: { name: `${MARK} property`, group: 'Property', type: 'Asset', processingHint: 'MANUAL', tenantId: b.tenantId } });
  const account = await prisma.account.create({
    data: {
      name: `${MARK} acct`, accountNumber: '99990000', bankId: ref.bankId, countryId: ref.countryId, currencyCode: ref.currencyCode,
      tenantId: b.tenantId, plaidAccountId: `b-plaid-${Date.now()}`,
    },
  });
  const tag = await prisma.tag.create({ data: { name: `${MARK} tag`, tenantId: b.tenantId } });
  const tx = await prisma.transaction.create({
    data: {
      transaction_date: new Date('2026-01-05T00:00:00Z'), year: 2026, month: 1, day: 5, quarter: 'Q1', categoryId: category.id,
      accountId: account.id, description: `${MARK} desc`, debit: 777.77, currency: 'USD', tenantId: b.tenantId,
      tags: { create: [{ tag: { connect: { id: tag.id } } }] },
    },
  });
  const insight = await prisma.insight.create({
    data: { tenantId: b.tenantId, batchId: 'b', date: new Date(), lens: 'SPENDING_VELOCITY', title: `${MARK} insight`, body: MARK, tier: 'MONTHLY', category: 'SPENDING', periodKey: '2026-01' },
  });
  const plaidItem = await prisma.plaidItem.create({ data: { tenantId: b.tenantId, userId: b.userId, itemId: `b-item-${Date.now()}`, accessToken: 'access-sandbox-b' } });
  const ptx = await prisma.plaidTransaction.create({
    data: {
      plaidItemId: plaidItem.id, plaidAccountId: account.plaidAccountId!, plaidTransactionId: `b-ptx-${Date.now()}`, amount: 5,
      date: new Date('2026-01-06T00:00:00Z'), name: `${MARK} merchant`, isoCurrencyCode: 'USD', suggestedCategoryId: category.id,
      aiConfidence: 0.99, promotionStatus: 'FAILED',
    },
  });
  const staged = await prisma.stagedImport.create({
    data: {
      tenantId: b.tenantId, userId: 'b@test', accountId: account.id, status: 'READY', fileName: `${MARK}.csv`, totalRows: 1,
      rows: { create: [{ rowNumber: 1, rawData: {}, description: `${MARK} row`, debit: 3, currency: 'USD', accountId: account.id, status: 'PENDING' }] },
    },
    include: { rows: true },
  });
  const asset = await prisma.portfolioItem.create({
    data: { tenantId: b.tenantId, categoryId: assetCat.id, symbol: `${MARK} flat`, currency: 'USD', source: 'MANUAL', quantity: 1, accountId: account.id },
  });
  const value = await prisma.manualAssetValue.create({ data: { tenantId: b.tenantId, assetId: asset.id, date: new Date('2026-01-01'), value: 1000, currency: 'USD' } });
  const stream = await prisma.incomeTerms.create({
    data: { tenantId: b.tenantId, categoryId: incomeCat.id, incomeType: 'FIXED_AMOUNT', name: `${MARK} stream`, amountPerPayment: 100, frequency: 'MONTHLY', currency: 'USD', startDate: new Date('2026-01-01') },
  });
  const detached = await prisma.incomeTerms.create({
    data: { tenantId: b.tenantId, incomeType: 'RENT', monthlyRent: 900, orphanedAt: new Date(), orphanedLabel: `${MARK} old` },
  });
  await prisma.recurringCharge.create({
    data: { tenantId: b.tenantId, descriptionHash: 'b-hash-1', merchantLabel: `${MARK} sub`, categoryId: category.id, cadence: 'MONTHLY', chargeKey: 'b-key-1' },
  });
  const bank = await prisma.bank.create({ data: { name: `${MARK} bank ${Date.now()}` } });
  await prisma.tenantBank.create({ data: { tenantId: b.tenantId, bankId: bank.id } });
  return {
    bankId: bank.id, userId: b.userId,
    categoryId: category.id, incomeCategoryId: incomeCat.id, accountId: account.id, tagId: tag.id, transactionId: tx.id,
    insightId: insight.id, plaidItemId: plaidItem.id, plaidTxId: ptx.id, importId: staged.id, rowId: staged.rows[0].id,
    assetId: asset.id, valueId: value.id, streamId: stream.id, detachedId: detached.id, subscriptionId: 'b-hash-1',
  };
}

async function snapshotB() {
  const [tx, ptx, row, value, streams, sub, insight, tag] = await Promise.all([
    prisma.transaction.findMany({ where: { tenantId: b.tenantId }, orderBy: { id: 'asc' } }),
    prisma.plaidTransaction.findUnique({ where: { id: B.plaidTxId } }),
    prisma.stagedImportRow.findUnique({ where: { id: B.rowId } }),
    prisma.manualAssetValue.findMany({ where: { tenantId: b.tenantId } }),
    prisma.incomeTerms.findMany({ where: { tenantId: b.tenantId }, orderBy: { id: 'asc' } }),
    prisma.recurringCharge.findMany({ where: { tenantId: b.tenantId } }),
    prisma.insight.findUnique({ where: { id: B.insightId } }),
    prisma.tag.findMany({ where: { tenantId: b.tenantId } }),
  ]);
  const item = await prisma.portfolioItem.findUnique({ where: { id: B.assetId } });
  const staged = await prisma.stagedImport.findUnique({ where: { id: B.importId } });
  return JSON.stringify({ tx, ptx, row, value, streams, sub, insight, tag, item, staged });
}

type Expect = 'notFound' | 'empty' | 'error' | 'perItemNotFound' | 'noEffect';
interface Case { tool: string; args: () => Record<string, unknown>; expect: Expect; text?: RegExp }

const CASES: Case[] = [
  { tool: 'manage_tags', args: () => ({ action: 'update', tagId: B.tagId, name: 'x' }), expect: 'notFound' },
  { tool: 'manage_tags', args: () => ({ action: 'delete', tagId: B.tagId }), expect: 'notFound' },
  { tool: 'search_transactions', args: () => ({ accountId: B.accountId }), expect: 'empty' },
  { tool: 'search_transactions', args: () => ({ categoryId: B.categoryId }), expect: 'empty' },
  { tool: 'search_transactions', args: () => ({ tag: String(B.tagId) }), expect: 'empty' },
  { tool: 'create_transaction', args: () => ({ date: '2026-01-01', accountId: B.accountId, categoryId: B.categoryId, description: 'x', amount: -1, currency: 'USD' }), expect: 'notFound' },
  { tool: 'update_transaction', args: () => ({ transactionId: B.transactionId, description: 'x' }), expect: 'notFound' },
  { tool: 'update_transaction', args: () => ({ transactionId: ownA.transactionId, categoryId: B.categoryId }), expect: 'notFound' },
  { tool: 'update_transaction', args: () => ({ transactionId: ownA.transactionId, accountId: B.accountId }), expect: 'notFound' },
  { tool: 'delete_transaction', args: () => ({ transactionId: B.transactionId }), expect: 'notFound' },
  { tool: 'get_tag_summary', args: () => ({ tagIds: [B.tagId], view: 'year', from: '2026', to: '2026', currency: 'USD' }), expect: 'empty' },
  { tool: 'dismiss_insight', args: () => ({ insightId: B.insightId }), expect: 'notFound' },
  { tool: 'get_plaid_review_queue', args: () => ({ categoryId: B.categoryId, status: 'ALL' }), expect: 'empty' },
  { tool: 'review_plaid_transactions', args: () => ({ items: [{ id: B.plaidTxId, action: 'skip' }] }), expect: 'perItemNotFound' },
  { tool: 'review_plaid_transactions', args: () => ({ bulkPromote: { ids: [B.plaidTxId] } }), expect: 'noEffect' },
  { tool: 'requeue_plaid_transactions', args: () => ({ failedIds: [B.plaidTxId] }), expect: 'perItemNotFound' },
  { tool: 'requeue_plaid_transactions', args: () => ({ allSkipped: true, plaidItemId: B.plaidItemId }), expect: 'noEffect' },
  { tool: 'list_plaid_seeds', args: () => ({ plaidItemId: B.plaidItemId }), expect: 'notFound' },
  { tool: 'confirm_plaid_seeds', args: () => ({ plaidItemId: B.plaidItemId, seeds: [{ description: 'x', categoryId: B.categoryId }] }), expect: 'notFound' },
  { tool: 'list_imports', args: () => ({ importId: B.importId }), expect: 'notFound' },
  { tool: 'review_import_rows', args: () => ({ importId: B.importId, rows: [{ rowId: B.rowId, status: 'SKIPPED' }] }), expect: 'perItemNotFound' },
  { tool: 'review_import_rows', args: () => ({ importId: B.importId, bulkConfirm: {} }), expect: 'notFound' },
  { tool: 'list_import_seeds', args: () => ({ importId: B.importId }), expect: 'notFound' },
  { tool: 'confirm_import_seeds', args: () => ({ importId: B.importId, seeds: [{ description: `${MARK} row`, categoryId: B.categoryId }] }), expect: 'notFound' },
  { tool: 'finalize_import', args: () => ({ importId: B.importId, action: 'cancel' }), expect: 'notFound' },
  { tool: 'get_portfolio_holdings', args: () => ({ accountId: B.accountId }), expect: 'empty' },
  { tool: 'get_portfolio_history', args: () => ({ accountId: B.accountId }), expect: 'empty' },
  { tool: 'get_equity_analysis', args: () => ({ accountId: B.accountId }), expect: 'empty' },
  { tool: 'get_holding_details', args: () => ({ assetId: B.assetId }), expect: 'notFound' },
  { tool: 'set_asset_class', args: () => ({ assetId: B.assetId, assetClass: 'CASH' }), expect: 'notFound' },
  { tool: 'manage_manual_values', args: () => ({ assetId: B.assetId, action: 'add', date: '2026-01-02', value: 1, currency: 'USD' }), expect: 'notFound' },
  { tool: 'manage_manual_values', args: () => ({ assetId: ownA.assetId, action: 'update', valueId: B.valueId, value: 1 }), expect: 'notFound' },
  { tool: 'manage_manual_values', args: () => ({ assetId: B.assetId, action: 'delete', valueId: B.valueId }), expect: 'notFound' },
  { tool: 'manage_income_and_debt_terms', args: () => ({ target: 'income', action: 'set', assetId: B.assetId, terms: { incomeType: 'NONE' } }), expect: 'notFound' },
  { tool: 'manage_income_and_debt_terms', args: () => ({ target: 'income', action: 'delete', assetId: B.assetId }), expect: 'notFound' },
  { tool: 'manage_income_and_debt_terms', args: () => ({ target: 'income', action: 'attach', termsId: B.detachedId, assetId: ownA.assetId }), expect: 'notFound' },
  { tool: 'manage_income_and_debt_terms', args: () => ({ target: 'income', action: 'deleteDetached', termsId: B.detachedId }), expect: 'notFound' },
  { tool: 'manage_income_and_debt_terms', args: () => ({ target: 'debt', action: 'set', assetId: B.assetId, initialBalance: 1, interestRate: 1, termInMonths: 12, originationDate: '2026-01-01' }), expect: 'notFound' },
  { tool: 'manage_passive_income_streams', args: () => ({ action: 'update', streamId: B.streamId, name: 'x' }), expect: 'notFound' },
  { tool: 'manage_passive_income_streams', args: () => ({ action: 'delete', streamId: B.streamId }), expect: 'notFound' },
  { tool: 'manage_passive_income_streams', args: () => ({ action: 'create', categoryId: B.incomeCategoryId, name: 'x', amountPerPayment: 1, frequency: 'MONTHLY', currency: 'USD', startDate: '2026-01-01' }), expect: 'error' },
  { tool: 'create_account', args: () => ({ name: 'x', bankId: B.bankId, currencyCode: 'USD', countryId: 'USA', accountNumber: '1' }), expect: 'error', text: /^Bank \d+ isn't linked to this workspace/ },
  { tool: 'create_account', args: () => ({ name: 'x', bankId: ownA.bankId, currencyCode: 'USD', countryId: 'USA', accountNumber: '1', ownerIds: [B.userId] }), expect: 'error', text: /ownerIds aren't users of this workspace/ },
  { tool: 'list_subscriptions', args: () => ({ view: 'all', categoryId: B.categoryId }), expect: 'empty' },
  { tool: 'update_subscription', args: () => ({ action: 'dismiss', subscriptionId: B.subscriptionId }), expect: 'notFound' },
  { tool: 'update_subscription', args: () => ({ action: 'confirm', transactionId: B.transactionId }), expect: 'notFound' },
  { tool: 'update_subscription', args: () => ({ action: 'merge', subscriptionId: B.subscriptionId, targetSubscriptionId: 'x' }), expect: 'notFound' },
];

function isEmpty(data: any) {
  const lists = ['items', 'rows', 'tags', 'groups', 'topHoldings', 'imports'];
  return lists.every((k) => data[k] === undefined || (Array.isArray(data[k]) && data[k].length === 0));
}

let client: any;

beforeAll(async () => {
  vi.stubGlobal('fetch', stub);
  server = await startLoopbackServer();
  a = await createIsolatedTenant('mcp-iso-a');
  b = await createIsolatedTenant('mcp-iso-b');
  B = await seedB();
  const ref = await ensureReferenceData();
  const catA = await prisma.category.create({ data: { name: 'A cat', group: 'Food', type: 'Essentials', tenantId: a.tenantId } });
  const assetCatA = await prisma.category.create({ data: { name: 'A property', group: 'Property', type: 'Asset', processingHint: 'MANUAL', tenantId: a.tenantId } });
  const accA = await prisma.account.create({ data: { name: 'A acct', accountNumber: '1', bankId: ref.bankId, countryId: ref.countryId, currencyCode: ref.currencyCode, tenantId: a.tenantId } });
  const txA = await prisma.transaction.create({
    data: { transaction_date: new Date('2026-01-05T00:00:00Z'), year: 2026, month: 1, day: 5, quarter: 'Q1', categoryId: catA.id, accountId: accA.id, description: 'A desc', debit: 1, currency: 'USD', tenantId: a.tenantId },
  });
  const assetA = await prisma.portfolioItem.create({ data: { tenantId: a.tenantId, categoryId: assetCatA.id, symbol: 'A flat', currency: 'USD', source: 'MANUAL', quantity: 1 } });
  // A can create accounts at its own bank in USD / USA (#98 create_account cases).
  await prisma.tenantBank.create({ data: { tenantId: a.tenantId, bankId: ref.bankId } });
  await prisma.tenantCurrency.create({ data: { tenantId: a.tenantId, currencyId: ref.currencyCode } });
  await prisma.tenantCountry.create({ data: { tenantId: a.tenantId, countryId: ref.countryId } });
  ownA = { transactionId: txA.id, assetId: assetA.id, bankId: ref.bankId };
  keyA = (await createIntegrationKey(a, { accessLevel: 'READ_WRITE' })).token;
  client = await connectMcp(server.baseUrl, keyA);
});

afterAll(async () => {
  await client?.close();
  await prisma.transactionTag.deleteMany({ where: { tag: { tenantId: b.tenantId } } });
  for (const tenantId of [a.tenantId, b.tenantId]) {
    await prisma.tenantBank.deleteMany({ where: { tenantId } });
    await prisma.tenantCurrency.deleteMany({ where: { tenantId } });
    await prisma.tenantCountry.deleteMany({ where: { tenantId } });
  }
  await teardownTenant(a.tenantId);
  await teardownTenant(b.tenantId);
  await server.close();
  vi.unstubAllGlobals();
});

describe('MCP tenant isolation (AC10)', () => {
  it('covers every tool that takes an ID', () => {
    const idTools = ALL_TOOLS
      .filter((t) => Object.keys(t.input).some((k) => (/Ids?$/.test(k) && k !== 'countryId') || ['items', 'rows', 'seeds'].includes(k)))
      .map((t) => t.name);
    const covered = new Set(CASES.map((c) => c.tool));
    expect(idTools.filter((n) => !covered.has(n))).toEqual([]);
  });

  it.each(CASES.map((c, i) => [`${c.tool} #${i}`, c] as const))('%s', async (_label, c) => {
    const before = await snapshotB();
    const result = await callTool(client, c.tool, c.args());
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(MARK);
    expect(serialized).not.toContain('777.77');

    switch (c.expect) {
      case 'notFound':
        expect(result.isError, result.text).toBe(true);
        expect(result.text).toMatch(/not found/i);
        break;
      case 'error':
        expect(result.isError, result.text).toBe(true);
        if (c.text) expect(result.text).toMatch(c.text);
        if (c.tool === 'create_account') expect(await prisma.account.count({ where: { tenantId: a.tenantId } })).toBe(1);
        break;
      case 'empty':
        expect(result.isError, result.text).toBe(false);
        expect(isEmpty(result.data), result.text).toBe(true);
        break;
      case 'perItemNotFound': {
        expect(result.isError, result.text).toBe(false);
        const entries = result.data.results ?? result.data.retried;
        expect(entries.every((e: any) => e.ok === false && /not found/i.test(e.error))).toBe(true);
        break;
      }
      case 'noEffect':
        expect(result.isError, result.text).toBe(false);
        break;
    }
    expect(await snapshotB()).toBe(before);
  });
});
