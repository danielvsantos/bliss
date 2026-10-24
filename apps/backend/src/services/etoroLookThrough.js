/**
 * eToro copy trade look-through for the backend (#143): the twin of the API's
 * `loadCopyLookThrough()` (apps/api/services/etoro.service.js), used by the
 * #80 insight lenses so a copy is split by sector exactly as on the Equity
 * Analysis page.
 *
 * Link rule: a Copy Trading holding is linked to the copies of its account's
 * eToro connections whose copied investor is its ticker (case-insensitive);
 * an ACTIVE copy wins, then the most recently started. Computed on read from
 * the stored copy holdings and SecurityMaster. No Twelve Data calls.
 */

const prisma = require('../../prisma/prisma');
const { deriveCopyComposition } = require('@bliss/shared/portfolio');

const COPY_TRADING_HINT = 'COPY_TRADING';

/**
 * @param {string} tenantId
 * @param {Array<{ id: number, symbol: string, accountId: number|null }>} items  Copy Trading holdings
 * @returns {Promise<Map<number, ReturnType<typeof deriveCopyComposition>>>} item id → composition (linked items only)
 */
async function loadCopyCompositions(tenantId, items) {
    const result = new Map();
    const wanted = items.filter((i) => i.accountId);
    if (wanted.length === 0) return result;

    const copies = await prisma.etoroCopy.findMany({
        where: {
            tenantId,
            parentUsername: { in: [...new Set(wanted.map((i) => String(i.symbol).trim().toLowerCase()))] },
            connection: { accountId: { in: [...new Set(wanted.map((i) => i.accountId))] } },
        },
        select: {
            parentUsername: true, status: true, startedAt: true, createdAt: true, holdings: true, cashPct: true,
            connection: { select: { accountId: true } },
        },
    });
    const rank = (c) => (c.status === 'ACTIVE' ? 1e15 : 0) + (c.startedAt || c.createdAt).getTime();
    const linked = new Map();
    for (const item of wanted) {
        const username = String(item.symbol).trim().toLowerCase();
        const best = copies
            .filter((c) => c.parentUsername === username && c.connection.accountId === item.accountId)
            .sort((a, b) => rank(b) - rank(a))[0];
        if (best) linked.set(item.id, best);
    }
    if (linked.size === 0) return result;

    const symbols = new Set();
    for (const copy of linked.values()) {
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
    for (const [itemId, copy] of linked) {
        result.set(itemId, deriveCopyComposition(
            { holdings: copy.holdings, cashPct: copy.cashPct == null ? 0 : Number(copy.cashPct) },
            bySymbol,
        ));
    }
    return result;
}

module.exports = { loadCopyCompositions, COPY_TRADING_HINT };
