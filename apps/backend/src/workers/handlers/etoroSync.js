/**
 * eToro copy trading sync (#143). Runs on the plaid-sync queue (decision D8):
 *
 *   ETORO_SYNC      { connectionId, tenantId, source }  — one connection
 *   ETORO_SYNC_ALL  {}                                  — scheduled fan-out (03:30 UTC)
 *
 * For one connection: read the account's copies (aggregate portfolio with
 * per-instrument detail + raw portfolio for the copied investor), upsert each
 * copy with its mapped holdings, mark copies gone from eToro CLOSED, write
 * today's copy value, then revalue the linked Copy Trading holdings.
 *
 * Never creates, changes or suggests a transaction. Never calls Twelve Data:
 * nothing here may require a module that reaches services/twelveDataService.js
 * (values are stored in eToro's account currency; FX happens in valuation).
 *
 * A key refused by eToro is probed with GET /me once before anything changes
 * (the #148 rule): confirmed → NEEDS_RECONNECT and the job resolves, so other
 * connections and jobs are unaffected; not confirmed → retryable failure.
 * See docs/specs/backend/25-etoro-copy-trading.md.
 */

const { UnrecoverableError } = require('bullmq');
const prisma = require('../../../prisma/prisma');
const logger = require('../../utils/logger');
const { carryOrigin } = require('../../utils/activityTracker');
const { getPlaidSyncQueue, etoroSyncOpts } = require('../../queues/plaidSyncQueue');
const { getPortfolioQueue } = require('../../queues/portfolioQueue');
const { enqueueLookThroughWatchlistRefresh } = require('../../queues/securityMasterQueue');
const {
    createEtoroClient,
    parseCopies,
    buildCopyHoldings,
    isKeyInvalid,
    EtoroError,
} = require('@bliss/shared/etoro');

const QUEUE_NAME = 'plaid-sync';
const COPY_TRADING_HINT = 'COPY_TRADING';

let clientFactory = createEtoroClient;

/** UTC midnight of `date`, the `EtoroCopyValue.day` key. */
function utcDay(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

async function recordFailure(connectionId, error, extra = {}) {
    await prisma.etoroConnection.update({
        where: { id: connectionId },
        data: { lastSyncAt: new Date(), lastSyncStatus: 'FAILED', lastSyncError: error, ...extra },
    });
}

/**
 * Copy Trading holdings of the connection's account whose ticker is one of
 * `usernames` (case-insensitive). Shared with the API's link resolution rule.
 */
async function findLinkedItems(tenantId, accountId, usernames) {
    if (!accountId || usernames.length === 0) return [];
    const wanted = new Set(usernames.map((u) => u.toLowerCase()));
    const items = await prisma.portfolioItem.findMany({
        where: { tenantId, accountId, category: { processingHint: COPY_TRADING_HINT } },
        select: { id: true, symbol: true },
    });
    return items.filter((i) => wanted.has(String(i.symbol).trim().toLowerCase()));
}

async function syncConnection(job) {
    const { connectionId } = job.data || {};
    if (!connectionId) throw new Error('connectionId is required');

    const connection = await prisma.etoroConnection.findUnique({ where: { id: connectionId } });
    if (!connection) {
        logger.warn(`[etoroSync] connection ${connectionId} not found — skipping`);
        return { skipped: 'not_found' };
    }
    if (connection.status !== 'ACTIVE') {
        logger.info(`[etoroSync] Skipping ${connectionId}: status is ${connection.status}`);
        return { skipped: 'inactive' };
    }

    const client = clientFactory({ apiKey: connection.apiKey, userKey: connection.userKey });
    const now = new Date();

    // 1. Read everything before writing anything: no partial writes on a bad response.
    let parsed;
    let instrumentMeta;
    try {
        const aggregate = await client.getAggregatePortfolio();
        const portfolio = await client.getPortfolio();
        parsed = parseCopies(aggregate, portfolio);
        instrumentMeta = await client.getInstruments(parsed.copies.flatMap((c) => c.instruments.map((i) => i.instrumentId)));
    } catch (err) {
        if (isKeyInvalid(err)) {
            const confirmed = await confirmKeyInvalid(client);
            if (confirmed) {
                await recordFailure(connection.id, 'KEY_INVALID', { status: 'NEEDS_RECONNECT', errorCode: 'KEY_INVALID' });
                logger.warn(`[etoroSync] eToro refused the key of connection ${connection.id}; needs reconnect`);
                return { status: 'NEEDS_RECONNECT' };
            }
            await recordFailure(connection.id, 'KEY_REFUSED_TRANSIENT');
            throw new EtoroError('UNAVAILABLE', 'eToro refused the request but the key is valid; will retry', { status: err.status });
        }
        const code = err instanceof EtoroError ? err.code : 'UNEXPECTED';
        await recordFailure(connection.id, code);
        if (code === 'SHAPE_CHANGED') {
            // Retrying won't change eToro's response shape: fail once, visibly.
            throw new UnrecoverableError(`eToro response shape changed: ${err.message}`);
        }
        throw err;
    }

    // 2. Upsert copies and their holdings; close the ones eToro no longer returns.
    const seenMirrorIds = [];
    const day = utcDay(now);
    const mapLogger = { warn: (msg, meta) => logger.warn(msg, { ...meta, connectionId: connection.id }) };
    for (const copy of parsed.copies) {
        const { holdings, cashPct, unmappedPct } = buildCopyHoldings(copy, instrumentMeta, { logger: mapLogger });
        const data = {
            parentUsername: copy.parentUsername,
            parentCid: copy.parentCid,
            startedAt: copy.startedAt,
            status: 'ACTIVE',
            closedAt: null,
            lastValue: copy.value,
            lastValueCurrency: parsed.currency,
            lastValueAt: now,
            holdings,
            cashPct,
            unmappedPct,
            holdingsAt: now,
        };
        const row = await prisma.etoroCopy.upsert({
            where: { connectionId_mirrorId: { connectionId: connection.id, mirrorId: copy.mirrorId } },
            create: { tenantId: connection.tenantId, connectionId: connection.id, mirrorId: copy.mirrorId, ...data },
            update: data,
        });
        seenMirrorIds.push(copy.mirrorId);

        // Values start at the connection date (R10); `now` is never before it.
        if (now >= connection.connectedAt) {
            await prisma.etoroCopyValue.upsert({
                where: { copyId_day: { copyId: row.id, day } },
                create: { tenantId: connection.tenantId, copyId: row.id, day, value: copy.value, currency: parsed.currency },
                update: { value: copy.value, currency: parsed.currency },
            });
        }
    }
    const closed = await prisma.etoroCopy.updateMany({
        where: { tenantId: connection.tenantId, connectionId: connection.id, status: 'ACTIVE', mirrorId: { notIn: seenMirrorIds } },
        data: { status: 'CLOSED', closedAt: now },
    });

    await prisma.etoroConnection.update({
        where: { id: connection.id },
        data: { lastSyncAt: now, lastSyncStatus: 'SUCCESS', lastSyncError: null, errorCode: null },
    });

    // 3. Symbols inside the copies with no security data yet: ask the security
    //    master for the look-through watchlist now instead of waiting for its
    //    weekly run (R20), so a new copy is split within one sync. The job is
    //    deduplicated and runs at BACKGROUND priority; this handler never calls
    //    Twelve Data itself.
    const missing = await countSymbolsWithoutData(seenMirrorIds, connection);
    if (missing > 0) {
        const queued = await enqueueLookThroughWatchlistRefresh({ reason: 'ETORO_SYNC' });
        logger.info(`[etoroSync] ${connection.id}: ${missing} copy symbol(s) without security data; look-through watchlist queued`, {
            jobId: queued?.id ?? null,
        });
    } else {
        logger.info(`[etoroSync] ${connection.id}: every copy symbol has security data; no watchlist refresh`);
    }

    // 4. Revalue the linked Copy Trading holdings (closed copies included: they keep their last value).
    const allCopies = await prisma.etoroCopy.findMany({
        where: { tenantId: connection.tenantId, connectionId: connection.id },
        select: { parentUsername: true },
    });
    const linked = await findLinkedItems(connection.tenantId, connection.accountId, allCopies.map((c) => c.parentUsername));
    if (linked.length > 0) {
        await getPortfolioQueue().add('value-portfolio-items', {
            tenantId: connection.tenantId,
            portfolioItemIds: linked.map((i) => i.id),
            ...carryOrigin(QUEUE_NAME, job),
        });
    }

    logger.info(
        `[etoroSync] ${connection.id}: ${parsed.copies.length} copies, ${closed.count} closed, ` +
        `${linked.length} linked holding(s) revalued`,
    );
    return { status: 'SUCCESS', copies: parsed.copies.length, closed: closed.count, linked: linked.length };
}

/** How many mapped stock/ETF symbols of the connection's active copies have no SecurityMaster row. */
async function countSymbolsWithoutData(mirrorIds, connection) {
    if (mirrorIds.length === 0) return 0;
    const copies = await prisma.etoroCopy.findMany({
        where: { tenantId: connection.tenantId, connectionId: connection.id, mirrorId: { in: mirrorIds } },
        select: { holdings: true },
    });
    const symbols = new Set();
    for (const copy of copies) {
        for (const h of Array.isArray(copy.holdings) ? copy.holdings : []) {
            if (h?.symbol && !h.unresolved && !h.nonEquity) symbols.add(String(h.symbol).toUpperCase());
        }
    }
    if (symbols.size === 0) return 0;
    const known = await prisma.securityMaster.count({ where: { symbol: { in: [...symbols] } } });
    return symbols.size - known;
}

/** True when GET /me with the same key is refused too. */
async function confirmKeyInvalid(client) {
    try {
        await client.getMe();
        return false;
    } catch (err) {
        return isKeyInvalid(err);
    }
}

/** Scheduled fan-out: one deduplicated sync per active connection. */
async function syncAll() {
    const active = await prisma.etoroConnection.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, tenantId: true },
    });
    const queue = getPlaidSyncQueue();
    for (const c of active) {
        await queue.add(
            'ETORO_SYNC',
            { connectionId: c.id, tenantId: c.tenantId, source: 'SCHEDULED', _trigger: 'nightly' },
            etoroSyncOpts(c.id),
        );
    }
    logger.info(`[etoroSync] Scheduled ${active.length} eToro sync(s)`);
    return { scheduled: active.length };
}

async function etoroDispatch(job) {
    switch (job.name) {
        case 'ETORO_SYNC':
            return syncConnection(job);
        case 'ETORO_SYNC_ALL':
            return syncAll();
        default:
            throw new Error(`Unknown eToro job: ${job.name}`);
    }
}

/** Tests only: replace the client factory (null restores the real one). */
function __setEtoroClientFactoryForTests(factory) {
    clientFactory = factory || createEtoroClient;
}

module.exports = {
    etoroDispatch,
    syncConnection,
    syncAll,
    findLinkedItems,
    __setEtoroClientFactoryForTests,
};
