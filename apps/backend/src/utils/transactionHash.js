const crypto = require('crypto');
const prisma = require('../../prisma/prisma');
const logger = require('./logger');

/**
 * Compute a deterministic SHA-256 hash for duplicate detection.
 * Must produce identical results across smartImportWorker, plaidProcessorWorker,
 * and the finance-api commit/promote endpoints.
 *
 * @param {Date|string} date     — Transaction date
 * @param {string}      description — Raw transaction description
 * @param {number|string} amount — Transaction amount (debit or credit)
 * @param {number}      accountId — Local Account ID
 * @returns {string}    — 64-char hex SHA-256 hash
 */
function computeTransactionHash(date, description, amount, accountId) {
    // Normalize to date-only (YYYY-MM-DD) so time components don't break matching.
    // Transaction.transaction_date is DateTime (may include time), while
    // PlaidTransaction.date is @db.Date (always midnight UTC).
    const d = date instanceof Date ? date : new Date(date);
    const isoDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const normalizedDesc = (description || '').trim().toLowerCase();
    const normalizedAmount = String(parseFloat(amount) || 0);
    const input = `${isoDate}${normalizedDesc}${normalizedAmount}${accountId}`;
    return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Build an in-memory Set of transaction hashes for O(1) duplicate detection.
 * Queries existing transactions within a narrow date window for the given account.
 *
 * Since the hash includes the date, only transactions with matching dates can
 * ever collide. A 1-day buffer on each side handles timezone edge cases.
 *
 * @param {string} tenantId
 * @param {number} accountId
 * @param {Date|null} minDate — Earliest date in the import batch (or null for 90-day default)
 * @param {Date|null} maxDate — Latest date in the import batch (or null for no upper bound)
 * @returns {Promise<Set<string>>}
 */
async function buildDuplicateHashSet(tenantId, accountId, minDate = null, maxDate = null) {
    // ── Compute date floor ────────────────────────────────────────────────────
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    let dateFloor = ninetyDaysAgo;
    if (minDate && minDate < ninetyDaysAgo) {
        dateFloor = new Date(minDate);
        dateFloor.setDate(dateFloor.getDate() - 1); // 1-day buffer for timezone edge cases
    }

    // ── Compute date ceiling ──────────────────────────────────────────────────
    let dateCeiling = null;
    if (maxDate) {
        dateCeiling = new Date(maxDate);
        dateCeiling.setDate(dateCeiling.getDate() + 1); // 1-day buffer
    }

    const dateFilter = { gte: dateFloor };
    if (dateCeiling) dateFilter.lte = dateCeiling;

    const existingTxs = await prisma.transaction.findMany({
        where: { accountId, tenantId, transaction_date: dateFilter },
        select: { transaction_date: true, description: true, credit: true, debit: true, accountId: true },
    });

    const hashSet = new Set();
    for (const tx of existingTxs) {
        const amount = tx.debit || tx.credit;
        const hash = computeTransactionHash(tx.transaction_date, tx.description, amount, tx.accountId);
        hashSet.add(hash);
    }

    logger.info(
        `Dedup hash set for account ${accountId}: ${hashSet.size} hashes from ${existingTxs.length} txs ` +
        `(window: ${dateFloor.toISOString()} → ${dateCeiling ? dateCeiling.toISOString() : 'now'})`
    );

    return hashSet;
}

module.exports = { computeTransactionHash, buildDuplicateHashSet };
