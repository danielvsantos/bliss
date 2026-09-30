const logger = require('../../utils/logger');

// Notes stamped on ManualAssetValue rows derived from buy transactions
// (`seedManualAssetValues` in process-portfolio-changes.js). Anything else is
// user-entered and must survive a prune.
const AUTO_SEEDED_NOTE = 'Auto-seeded from purchase transaction';
const userManualValuesWhere = (assetIds) => ({
    assetId: { in: assetIds },
    OR: [{ notes: null }, { notes: { not: AUTO_SEEDED_NOTE } }],
});

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
 * User-entered manual values (appraisals, i.e. every `ManualAssetValue` not
 * auto-seeded from a purchase) travel the same way; the target's auto-seeded
 * values are regenerated from its own transactions. A target that already owns
 * IncomeTerms / DebtTerms (both 1:1 per asset) keeps its own: the orphan's
 * IncomeTerms are then detached and its DebtTerms cascade as before.
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

    const [incomeRows, debtRows, overrideRows, manualRows] = await Promise.all([
        tx.incomeTerms.findMany({ where: { assetId: { in: orphanIds } }, select: { id: true, assetId: true } }),
        tx.debtTerms.findMany({ where: { assetId: { in: orphanIds } }, select: { id: true, assetId: true } }),
        tx.portfolioItem.findMany({
            where: { id: { in: orphanIds }, assetClassOverride: { not: null } },
            select: { id: true, assetClassOverride: true },
        }),
        tx.manualAssetValue.findMany({ where: userManualValuesWhere(orphanIds), select: { assetId: true } }),
    ]);
    const incomeByAsset = new Map(incomeRows.map((r) => [r.assetId, r]));
    const debtByAsset = new Map(debtRows.map((r) => [r.assetId, r]));
    const overrideByAsset = new Map((overrideRows || []).map((r) => [r.id, r.assetClassOverride]));
    const hasManualValues = new Set((manualRows || []).map((r) => r.assetId));
    if (incomeByAsset.size === 0 && debtByAsset.size === 0 && overrideByAsset.size === 0 && hasManualValues.size === 0) {
        return { moved: 0, detached: 0 };
    }

    // Decide matches first so "each candidate is used once" holds across orphans:
    // a candidate claimed by two orphans is ambiguous for both.
    const withTerms = orphans.filter((o) =>
        incomeByAsset.has(o.id) || debtByAsset.has(o.id) || overrideByAsset.has(o.id) || hasManualValues.has(o.id));
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

    // Terms are 1:1 per asset, so a target that already owns one keeps it.
    const candidateIds = [...claims.keys()];
    const [targetIncome, targetDebt] = candidateIds.length > 0
        ? await Promise.all([
            tx.incomeTerms.findMany({ where: { assetId: { in: candidateIds } }, select: { assetId: true } }),
            tx.debtTerms.findMany({ where: { assetId: { in: candidateIds } }, select: { assetId: true } }),
        ])
        : [[], []];
    const targetHasIncome = new Set((targetIncome || []).map((r) => r.assetId));
    const targetHasDebt = new Set((targetDebt || []).map((r) => r.assetId));

    let moved = 0;
    let detached = 0;
    const now = new Date();
    for (const o of withTerms) {
        const candidates = candidatesFor.get(o.id);
        const target = candidates.length === 1 && claims.get(candidates[0].id) === 1 ? candidates[0] : null;
        const income = incomeByAsset.get(o.id);
        const debt = debtByAsset.get(o.id);
        const override = overrideByAsset.get(o.id);

        const detachIncome = async () => {
            await tx.incomeTerms.update({
                where: { id: income.id },
                data: { assetId: null, orphanedAt: now, orphanedLabel: o.symbol },
            });
            detached += 1;
        };

        if (target) {
            if (income && !targetHasIncome.has(target.id)) {
                await tx.incomeTerms.update({ where: { id: income.id }, data: { assetId: target.id } });
            } else if (income) {
                await detachIncome();
                logger.info(`[Sync] Detached income terms ${income.id} from pruned item ${o.id} (${o.symbol}); target ${target.id} already has its own.`);
            }
            if (debt && !targetHasDebt.has(target.id)) {
                await tx.debtTerms.update({ where: { id: debt.id }, data: { assetId: target.id } });
            }
            if (hasManualValues.has(o.id)) {
                await tx.manualAssetValue.updateMany({
                    where: userManualValuesWhere([o.id]),
                    data: { assetId: target.id },
                });
            }
            if (override) {
                await tx.portfolioItem.updateMany({
                    where: { id: target.id, assetClassOverride: null },
                    data: { assetClassOverride: override },
                });
            }
            moved += 1;
            logger.info(`[Sync] Moved terms, override and manual values from pruned item ${o.id} (${o.symbol}) to new item ${target.id} (${target.symbol}).`);
        } else if (income) {
            await detachIncome();
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
