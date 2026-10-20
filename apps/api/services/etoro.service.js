/**
 * eToro copy trading (#143) — connections, the copy ↔ holding link, and the
 * "switch to Copy Trading" conversion.
 *
 * Keys: the Read key pair is checked against eToro before it is stored,
 * encrypted at rest by the Prisma extension, and never part of any response
 * (`keyLast4` only). Data fetched with a tenant's key serves that tenant only.
 *
 * Link rule (shared with the backend sync and valuation): a Copy Trading
 * holding is linked to the copies of its account's connections whose copied
 * investor is its ticker, case-insensitive. Nothing stores the link.
 *
 * See docs/specs/api/28-etoro-api.md and docs/specs/backend/25-etoro-copy-trading.md.
 */

import { StatusCodes } from 'http-status-codes';
import prisma from '../prisma/prisma.js';
import { assertReadOnlyScopes, EtoroError, EtoroScopeError, parseCopies } from '@bliss/shared/etoro';
import { deriveCopyComposition } from '@bliss/shared/portfolio';
import { etoroClient } from '../utils/etoro.js';
import { produceEvent } from '../utils/produceEvent.js';

export const COPY_TRADING_HINT = 'COPY_TRADING';
export const COPY_TRADING_CODE = 'COPY_TRADING';
const MAX_KEY_LENGTH = 1024;
/** eToro usernames: letters, digits, `_`, `-`, `.`. */
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{1,39}$/;

export class EtoroServiceError extends Error {
  constructor(status, body) {
    super(body.error);
    this.status = status;
    this.body = body;
  }
}

const fail = (status, code, error, extra = {}) => new EtoroServiceError(status, { error, code, ...extra });

/** `@TopInvestor ` → `topinvestor`, or null when it isn't a plausible eToro username. */
export function normalizeUsername(value) {
  if (typeof value !== 'string') return null;
  const u = value.trim().replace(/^@/, '').toLowerCase();
  return USERNAME_PATTERN.test(u) ? u : null;
}

function readKeys(body) {
  const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
  const userKey = typeof body?.userKey === 'string' ? body.userKey.trim() : '';
  if (!apiKey || !userKey) {
    throw fail(StatusCodes.BAD_REQUEST, 'KEYS_REQUIRED', 'Both the eToro API key and the user key are required');
  }
  if (apiKey.length > MAX_KEY_LENGTH || userKey.length > MAX_KEY_LENGTH) {
    throw fail(StatusCodes.BAD_REQUEST, 'KEYS_INVALID_FORMAT', 'eToro keys are too long');
  }
  return { apiKey, userKey };
}

async function readAccount(tenantId, accountId) {
  const id = Number.parseInt(accountId, 10);
  if (!Number.isInteger(id)) throw fail(StatusCodes.BAD_REQUEST, 'ACCOUNT_REQUIRED', 'Choose the Bliss account this eToro login maps to');
  const account = await prisma.account.findFirst({ where: { id, tenantId }, select: { id: true, name: true } });
  if (!account) throw fail(StatusCodes.BAD_REQUEST, 'ACCOUNT_NOT_FOUND', 'Account not found');
  return account;
}

/** eToro client errors → API errors. Never carries eToro's response body. */
function toServiceError(err) {
  if (err instanceof EtoroServiceError) return err;
  if (err instanceof EtoroScopeError) {
    return fail(StatusCodes.BAD_REQUEST, 'ETORO_WRITE_SCOPE',
      'This key can place trades. Create a Read key in eToro (Settings → Trading → API Key Management) and use that one.',
      { writeScopes: err.writeScopes });
  }
  if (err instanceof EtoroError) {
    if (err.code === 'KEY_INVALID') {
      return fail(StatusCodes.UNPROCESSABLE_ENTITY, 'ETORO_KEY_INVALID', 'eToro did not accept this key. Check both keys and that the key has not expired.');
    }
    if (err.code === 'RATE_LIMITED') {
      return fail(StatusCodes.TOO_MANY_REQUESTS, 'ETORO_RATE_LIMITED', 'eToro is limiting requests for this key. Try again in a minute.');
    }
    return fail(StatusCodes.BAD_GATEWAY, 'ETORO_UNAVAILABLE', 'eToro could not be reached. Try again later.');
  }
  return err;
}

/**
 * Checks a key pair with eToro: identity + read-only scopes, then the copy
 * list for the preview (two to three calls, ~1 s).
 */
async function checkKeys(keys) {
  const client = etoroClient(keys);
  const me = await client.getMe();
  const scopes = assertReadOnlyScopes(me.scopes);
  const aggregate = await client.getAggregatePortfolio();
  const portfolio = await client.getPortfolio();
  const { currency, copies } = parseCopies(aggregate, portfolio);
  return {
    me: { ...me, scopes },
    preview: copies.map((c) => ({
      parentUsername: c.parentUsername,
      startedAt: c.startedAt,
      value: c.value,
      currency,
    })),
  };
}

// ── Link resolution ────────────────────────────────────────────────────────

/**
 * Copy Trading holdings linked to each of `copies` (same tenant, the copy's
 * connection account, ticker = copied investor).
 *
 * @param {string} tenantId
 * @param {Array<{ parentUsername: string, connection: { accountId: number|null } }>} copies
 * @returns {Promise<Map<string, { id: number, symbol: string }>>} key `${accountId}:${username}`
 */
async function linkedHoldings(tenantId, copies) {
  const accountIds = [...new Set(copies.map((c) => c.connection?.accountId).filter(Boolean))];
  if (accountIds.length === 0) return new Map();
  const items = await prisma.portfolioItem.findMany({
    where: { tenantId, accountId: { in: accountIds }, category: { processingHint: COPY_TRADING_HINT } },
    select: { id: true, symbol: true, accountId: true },
  });
  return new Map(items.map((i) => [`${i.accountId}:${String(i.symbol).trim().toLowerCase()}`, { id: i.id, symbol: i.symbol }]));
}

/**
 * The eToro copy behind each Copy Trading holding (R7). When several copies
 * match (a restarted copy), an ACTIVE one wins, then the most recently started.
 *
 * @param {string} tenantId
 * @param {Array<{ id: number, symbol: string, accountId: number|null }>} items
 * @returns {Promise<Map<number, Object>>} item id → copy (with `connection: { id, status, accountId }`)
 */
export async function findCopiesForItems(tenantId, items) {
  const result = new Map();
  const wanted = items.filter((i) => i.accountId);
  if (wanted.length === 0) return result;
  const usernames = [...new Set(wanted.map((i) => String(i.symbol).trim().toLowerCase()))];
  const copies = await prisma.etoroCopy.findMany({
    where: {
      tenantId,
      parentUsername: { in: usernames },
      connection: { accountId: { in: [...new Set(wanted.map((i) => i.accountId))] } },
    },
    include: { connection: { select: { id: true, status: true, accountId: true } } },
  });
  const rank = (c) => [c.status === 'ACTIVE' ? 1 : 0, (c.startedAt || c.createdAt).getTime()];
  for (const item of wanted) {
    const username = String(item.symbol).trim().toLowerCase();
    const matches = copies
      .filter((c) => c.parentUsername === username && c.connection.accountId === item.accountId)
      .sort((a, b) => {
        const [sa, ta] = rank(a);
        const [sb, tb] = rank(b);
        return sb - sa || tb - ta;
      });
    if (matches.length > 0) result.set(item.id, matches[0]);
  }
  return result;
}

/**
 * The `copyTrade` block of a Copy Trading holding, for badges (R12).
 * `linked: false` = no copy found; the holding behaves as a manual Fund.
 */
export function copyTradeStatus(copy) {
  if (!copy) return { linked: false };
  return {
    linked: true,
    copyId: copy.id,
    status: copy.status, // ACTIVE | CLOSED
    connectionStatus: copy.connection?.status ?? null, // ACTIVE | NEEDS_RECONNECT | REMOVED
    lastValueAt: copy.lastValueAt,
    unmappedPct: copy.unmappedPct == null ? null : Number(copy.unmappedPct),
  };
}

// ── Connections ────────────────────────────────────────────────────────────

const CONNECTION_SELECT = {
  id: true,
  etoroUsername: true,
  accountId: true,
  keyLast4: true,
  scopes: true,
  status: true,
  errorCode: true,
  connectedAt: true,
  lastSyncAt: true,
  lastSyncStatus: true,
  lastSyncError: true,
  createdAt: true,
  account: { select: { id: true, name: true } },
  copies: {
    select: {
      id: true,
      mirrorId: true,
      parentUsername: true,
      startedAt: true,
      status: true,
      closedAt: true,
      lastValue: true,
      lastValueCurrency: true,
      lastValueAt: true,
      cashPct: true,
      unmappedPct: true,
      holdings: true,
    },
    orderBy: [{ status: 'asc' }, { parentUsername: 'asc' }],
  },
};

const num = (v) => (v == null ? null : Number(v));

/** A connection as the API returns it. Never includes the keys. */
function connectionDto(c, linked) {
  return {
    id: c.id,
    etoroUsername: c.etoroUsername,
    accountId: c.accountId,
    account: c.account,
    keyLast4: c.keyLast4,
    scopes: c.scopes,
    status: c.status,
    errorCode: c.errorCode,
    connectedAt: c.connectedAt,
    lastSyncAt: c.lastSyncAt,
    lastSyncStatus: c.lastSyncStatus,
    lastSyncError: c.lastSyncError,
    copies: (c.copies || []).map((copy) => ({
      id: copy.id,
      parentUsername: copy.parentUsername,
      startedAt: copy.startedAt,
      status: copy.status,
      closedAt: copy.closedAt,
      lastValue: num(copy.lastValue),
      lastValueCurrency: copy.lastValueCurrency,
      lastValueAt: copy.lastValueAt,
      cashPct: num(copy.cashPct),
      unmappedPct: num(copy.unmappedPct),
      holdingsCount: Array.isArray(copy.holdings) ? copy.holdings.length : 0,
      linkedHolding: linked.get(`${c.accountId}:${copy.parentUsername}`) || null,
    })),
  };
}

/** Every connection of the tenant except removed ones, with copies and links. */
export async function listConnections(tenantId) {
  const rows = await prisma.etoroConnection.findMany({
    where: { tenantId, status: { not: 'REMOVED' } },
    select: CONNECTION_SELECT,
    orderBy: { createdAt: 'asc' },
  });
  const linked = await linkedHoldings(tenantId, rows.flatMap((c) => c.copies.map((copy) => ({ ...copy, connection: c }))));
  return rows.map((c) => connectionDto(c, linked));
}

async function loadConnection(tenantId, id) {
  const row = await prisma.etoroConnection.findFirst({ where: { id: String(id), tenantId }, select: CONNECTION_SELECT });
  if (!row) throw fail(StatusCodes.NOT_FOUND, 'NOT_FOUND', 'Connection not found');
  return row;
}

async function connectionView(tenantId, id) {
  const row = await loadConnection(tenantId, id);
  const linked = await linkedHoldings(tenantId, row.copies.map((copy) => ({ ...copy, connection: row })));
  return connectionDto(row, linked);
}

async function requestSync(tenantId, connectionId, source) {
  await produceEvent({ type: 'ETORO_SYNC', tenantId, connectionId, source });
}

/**
 * POST /api/etoro/connections (R1, R2). Nothing is stored unless eToro
 * accepts the key, every scope is read-only and the login isn't connected yet.
 * A removed connection of the same login is reactivated (its copies and
 * values are kept).
 *
 * @returns {Promise<{ connection: Object, copies: Array, reactivated: boolean }>}
 */
export async function connect({ tenantId, userId, body }) {
  const keys = readKeys(body);
  const account = await readAccount(tenantId, body?.accountId);

  let checked;
  try {
    checked = await checkKeys(keys);
  } catch (err) {
    throw toServiceError(err);
  }
  const { me, preview } = checked;

  const existing = await prisma.etoroConnection.findUnique({
    where: { tenantId_etoroCid: { tenantId, etoroCid: me.cid } },
    select: { id: true, status: true },
  });
  if (existing && existing.status !== 'REMOVED') {
    throw fail(StatusCodes.CONFLICT, 'ETORO_ALREADY_CONNECTED', 'This eToro account is already connected', { connectionId: existing.id });
  }

  const data = {
    accountId: account.id,
    etoroUsername: me.username || me.cid,
    apiKey: keys.apiKey,
    userKey: keys.userKey,
    keyLast4: keys.apiKey.slice(-4),
    scopes: me.scopes,
    status: 'ACTIVE',
    errorCode: null,
  };
  const row = existing
    ? await prisma.etoroConnection.update({ where: { id: existing.id }, data, select: { id: true } })
    : await prisma.etoroConnection.create({
      data: { tenantId, createdByUserId: userId, etoroCid: me.cid, ...data },
      select: { id: true },
    });

  await requestSync(tenantId, row.id, 'CONNECT');
  return { connection: await connectionView(tenantId, row.id), copies: preview, reactivated: Boolean(existing) };
}

/**
 * PUT /api/etoro/connections/:id — replace the key (same eToro login only,
 * R3) and/or change the mapped account. A replaced key reactivates a
 * connection that needed a reconnect, without losing data.
 */
export async function updateConnection({ tenantId, id, body }) {
  const current = await loadConnection(tenantId, id);
  if (current.status === 'REMOVED') throw fail(StatusCodes.BAD_REQUEST, 'CONNECTION_REMOVED', 'This connection was removed. Connect the account again.');

  const data = {};
  if (body?.accountId !== undefined) {
    data.accountId = (await readAccount(tenantId, body.accountId)).id;
  }
  const replacingKey = body?.apiKey !== undefined || body?.userKey !== undefined;
  if (replacingKey) {
    const keys = readKeys(body);
    let me;
    try {
      const client = etoroClient(keys);
      me = await client.getMe();
      me.scopes = assertReadOnlyScopes(me.scopes);
    } catch (err) {
      throw toServiceError(err);
    }
    const { etoroCid } = await prisma.etoroConnection.findUnique({ where: { id: current.id }, select: { etoroCid: true } });
    if (me.cid !== etoroCid) {
      throw fail(StatusCodes.CONFLICT, 'ETORO_DIFFERENT_LOGIN', 'This key belongs to a different eToro account. Connect that account separately.');
    }
    Object.assign(data, {
      apiKey: keys.apiKey,
      userKey: keys.userKey,
      keyLast4: keys.apiKey.slice(-4),
      scopes: me.scopes,
      status: 'ACTIVE',
      errorCode: null,
      ...(me.username && { etoroUsername: me.username }),
    });
  }
  if (Object.keys(data).length === 0) {
    throw fail(StatusCodes.BAD_REQUEST, 'NOTHING_TO_UPDATE', 'Send a new key pair or an accountId');
  }

  await prisma.etoroConnection.update({ where: { id: current.id }, data });
  if (replacingKey || data.accountId !== undefined) await requestSync(tenantId, current.id, replacingKey ? 'KEY_REPLACED' : 'ACCOUNT_CHANGED');
  return connectionView(tenantId, current.id);
}

/**
 * DELETE /api/etoro/connections/:id (R3): stops updates and wipes the keys.
 * Copies, values and the holdings' history are kept.
 */
export async function removeConnection({ tenantId, id }) {
  const current = await loadConnection(tenantId, id);
  await prisma.etoroConnection.update({
    where: { id: current.id },
    data: { status: 'REMOVED', apiKey: '', userKey: '', keyLast4: '' },
  });
}

/** Loads an ACTIVE connection for "Sync now"; throws otherwise. */
export async function loadSyncableConnection(tenantId, id) {
  const current = await loadConnection(tenantId, id);
  if (current.status !== 'ACTIVE') {
    throw fail(StatusCodes.BAD_REQUEST, 'CONNECTION_NOT_ACTIVE', `Cannot sync: the connection is ${current.status}. Replace the key first.`);
  }
  return current;
}

export async function triggerSync(tenantId, id) {
  await requestSync(tenantId, id, 'MANUAL');
}

// ── Switch a holding to Copy Trading (R8) ──────────────────────────────────

/**
 * Moves an existing investment holding (e.g. a manual Fund "copy of @x") to
 * the Copy Trading category in place: its transactions get the category and
 * the investor as ticker, and the PortfolioItem keeps its id, so IncomeTerms,
 * manual values and history stay attached. Amounts and dates never change.
 */
export async function convertHolding({ tenantId, body }) {
  const itemId = Number.parseInt(body?.portfolioItemId, 10);
  if (!Number.isInteger(itemId)) throw fail(StatusCodes.BAD_REQUEST, 'PORTFOLIO_ITEM_REQUIRED', 'portfolioItemId is required');
  const username = normalizeUsername(body?.etoroUsername);
  if (!username) throw fail(StatusCodes.BAD_REQUEST, 'INVALID_USERNAME', 'Enter the eToro username of the investor you copy');

  const item = await prisma.portfolioItem.findFirst({
    where: { id: itemId, tenantId },
    include: { category: { select: { id: true, type: true, group: true, processingHint: true } } },
  });
  if (!item) throw fail(StatusCodes.NOT_FOUND, 'NOT_FOUND', 'Holding not found');
  if (item.category.processingHint === COPY_TRADING_HINT) {
    throw fail(StatusCodes.BAD_REQUEST, 'ALREADY_COPY_TRADING', 'This holding is already a Copy Trading holding');
  }
  if (item.category.type !== 'Investments') {
    throw fail(StatusCodes.BAD_REQUEST, 'NOT_AN_INVESTMENT', 'Only investment holdings can be switched to Copy Trading');
  }

  const category = await prisma.category.findFirst({
    where: { tenantId, OR: [{ defaultCategoryCode: COPY_TRADING_CODE }, { processingHint: COPY_TRADING_HINT }] },
    orderBy: { id: 'asc' },
    select: { id: true, group: true },
  });
  if (!category) {
    throw fail(StatusCodes.CONFLICT, 'COPY_TRADING_CATEGORY_MISSING', 'The Copy Trading category is missing for this workspace');
  }

  const clash = await prisma.portfolioItem.findFirst({
    where: { tenantId, symbol: username, accountId: item.accountId, id: { not: item.id } },
    select: { id: true },
  });
  if (clash) {
    throw fail(StatusCodes.CONFLICT, 'COPY_HOLDING_EXISTS', 'This account already has a holding for that investor', { portfolioItemId: clash.id });
  }

  const [moved] = await prisma.$transaction([
    prisma.transaction.updateMany({
      where: { tenantId, portfolioItemId: item.id },
      data: { categoryId: category.id, ticker: username, isin: null, exchange: null, assetCurrency: null },
    }),
    prisma.portfolioItem.update({
      where: { id: item.id },
      data: { categoryId: category.id, symbol: username, isin: null, exchange: null, assetCurrency: null, source: 'SYNCED' },
    }),
  ]);

  // Revalue the holding (it may now be linked to an eToro copy). Analytics is
  // keyed by category group, so a move from another group rebuilds it.
  await produceEvent({ type: 'MANUAL_PORTFOLIO_PRICE_UPDATED', tenantId, portfolioItemId: item.id });
  if (item.category.group !== category.group) {
    await produceEvent({ type: 'CATEGORY_CLASSIFICATION_CHANGED', tenantId, categoryId: category.id, portfolioImpact: false });
  }

  return { portfolioItemId: item.id, symbol: username, categoryId: category.id, transactionsMoved: moved.count };
}

// ── Look-through (Equity Analysis, R13–R17) ────────────────────────────────

/**
 * The derived look-through of each linked Copy Trading holding, computed on
 * read from the copy's stored holdings and SecurityMaster (one query for all
 * copies). Unlinked holdings get `{ copy: null, composition: null }`.
 *
 * @param {string} tenantId
 * @param {Array<{ id: number, symbol: string, accountId: number|null }>} items
 * @returns {Promise<Map<number, { copy: Object|null, composition: ReturnType<typeof deriveCopyComposition>|null }>>}
 */
export async function loadCopyLookThrough(tenantId, items) {
  const copies = await findCopiesForItems(tenantId, items);
  const symbols = new Set();
  for (const copy of copies.values()) {
    for (const h of Array.isArray(copy.holdings) ? copy.holdings : []) {
      if (h?.symbol && !h.nonEquity && !h.unresolved) symbols.add(String(h.symbol).toUpperCase());
    }
  }
  const securities = symbols.size
    ? await prisma.securityMaster.findMany({
      where: { symbol: { in: [...symbols] } },
      select: {
        symbol: true, name: true, assetType: true, sector: true, country: true,
        peRatio: true, earningsTrusted: true, dividendYield: true, dividendTrusted: true, etfComposition: true,
      },
    })
    : [];
  const bySymbol = new Map(securities.map((s) => [s.symbol, s]));

  const result = new Map();
  for (const item of items) {
    const copy = copies.get(item.id) || null;
    result.set(item.id, {
      copy,
      composition: copy
        ? deriveCopyComposition({ holdings: copy.holdings, cashPct: copy.cashPct == null ? 0 : Number(copy.cashPct) }, bySymbol)
        : null,
    });
  }
  return result;
}
