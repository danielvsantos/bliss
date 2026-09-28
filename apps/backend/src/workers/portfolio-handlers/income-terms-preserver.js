const logger = require('../../utils/logger');

/**
 * Keep user-entered income terms alive when a portfolio rebuild prunes an item
 * whose key changed (a corrected description, category, account or symbol after
 * a wrong import). Passive Income, #77 — R7.5.
 *
 * Called inside the prune transaction, BEFORE `portfolioItem.deleteMany`:
 *
 *   1. Load the orphans that own `IncomeTerms` or `DebtTerms`.
 *   2. For each, look for a NEWLY created item in this run with the same
 *      `categoryId` AND either the same `accountId` (corrected description) or
 *      the same `symbol` (corrected account). Each candidate is used once.
 *      - Exactly one candidate → move both rows to it (update `assetId`).
 *      - Otherwise → DETACH the IncomeTerms (assetId = null, orphanedAt,
 *        orphanedLabel = old symbol). DebtTerms keep today's behaviour and are
 *        deleted with the item by cascade.
 *
 * The item's asset class override (#79) travels with it: an orphan that owns
 * one is matched the same way, and on a move the override is copied to the new
 * item (unless that item already has its own). A detached orphan's override is
 * lost with the item.
 *
 * Intentional deletions (the user deletes an asset, or recalculate-portfolio-item
 * removes an item with no transactions left) are NOT routed through here, so
 * their terms still cascade away.
 *
 * @param {Object} tx         Prisma transaction client
 * @param {Array<{id, symbol, accountId, categoryId}>} orphans  items about to be pruned
 * @param {Array<{id, symbol, accountId, categoryId}>} newItems items created in this run
 * @returns {Promise<{ moved: number, detached: number }>}
 */
async function preserveTermsBeforePrune(tx, orphans, newItems = []) {
    if (!orphans || orphans.length === 0) return { moved: 0, detached: 0 };
    const orphanIds = orphans.map((o) => o.id);

    const [incomeRows, debtRows, overrideRows] = await Promise.all([
        tx.incomeTerms.findMany({ where: { assetId: { in: orphanIds } }, select: { id: true, assetId: true } }),
        tx.debtTerms.findMany({ where: { assetId: { in: orphanIds } }, select: { id: true, assetId: true } }),
        tx.portfolioItem.findMany({
            where: { id: { in: orphanIds }, assetClassOverride: { not: null } },
            select: { id: true, assetClassOverride: true },
        }),
    ]);
    const incomeByAsset = new Map(incomeRows.map((r) => [r.assetId, r]));
    const debtByAsset = new Map(debtRows.map((r) => [r.assetId, r]));
    const overrideByAsset = new Map((overrideRows || []).map((r) => [r.id, r.assetClassOverride]));
    if (incomeByAsset.size === 0 && debtByAsset.size === 0 && overrideByAsset.size === 0) {
        return { moved: 0, detached: 0 };
    }

    // Decide matches first so "each candidate is used once" holds across orphans:
    // a candidate claimed by two orphans is ambiguous for both.
    const withTerms = orphans.filter((o) => incomeByAsset.has(o.id) || debtByAsset.has(o.id) || overrideByAsset.has(o.id));
    const candidatesFor = new Map();
    const claims = new Map();
    for (const o of withTerms) {
        const candidates = newItems.filter((n) =>
            n.id !== o.id &&
            n.categoryId === o.categoryId &&
            ((o.accountId != null && n.accountId === o.accountId) || n.symbol === o.symbol)
        );
        candidatesFor.set(o.id, candidates);
        for (const c of candidates) claims.set(c.id, (claims.get(c.id) || 0) + 1);
    }

    let moved = 0;
    let detached = 0;
    const now = new Date();
    for (const o of withTerms) {
        const candidates = candidatesFor.get(o.id);
        const target = candidates.length === 1 && claims.get(candidates[0].id) === 1 ? candidates[0] : null;
        const income = incomeByAsset.get(o.id);
        const debt = debtByAsset.get(o.id);
        const override = overrideByAsset.get(o.id);

        if (target) {
            if (income) await tx.incomeTerms.update({ where: { id: income.id }, data: { assetId: target.id } });
            if (debt) await tx.debtTerms.update({ where: { id: debt.id }, data: { assetId: target.id } });
            if (override) {
                await tx.portfolioItem.updateMany({
                    where: { id: target.id, assetClassOverride: null },
                    data: { assetClassOverride: override },
                });
            }
            moved += 1;
            logger.info(`[Sync] Moved income/debt terms from pruned item ${o.id} (${o.symbol}) to new item ${target.id} (${target.symbol}).`);
        } else if (income) {
            await tx.incomeTerms.update({
                where: { id: income.id },
                data: { assetId: null, orphanedAt: now, orphanedLabel: o.symbol },
            });
            detached += 1;
            logger.info(`[Sync] Detached income terms ${income.id} from pruned item ${o.id} (${o.symbol}); ${candidates.length} candidate(s).`);
        }
    }
    return { moved, detached };
}

/**
 * Prune orphan portfolio items, preserving their income terms first. Runs in
 * one interactive transaction so terms are never lost to a half-applied prune.
 */
async function pruneItemsPreservingTerms(prisma, orphans, newItems = []) {
    if (!orphans || orphans.length === 0) return { moved: 0, detached: 0, deleted: 0 };
    return prisma.$transaction(async (tx) => {
        const result = await preserveTermsBeforePrune(tx, orphans, newItems);
        const { count } = await tx.portfolioItem.deleteMany({ where: { id: { in: orphans.map((o) => o.id) } } });
        return { ...result, deleted: count };
    });
}

module.exports = { preserveTermsBeforePrune, pruneItemsPreservingTerms };
