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
 * Queries existing transactions within a date window for the given account.
 *
 * @param {string} tenantId
 * @param {number} accountId
 * @param {Date|null} minDate — Optional: expand window below the default 90 days
 * @returns {Promise<Set<string>>}
 */
async function buildDuplicateHashSet(tenantId, accountId, minDate = null) {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    let dateFloor = ninetyDaysAgo;
    if (minDate && minDate < ninetyDaysAgo) {
        dateFloor = new Date(minDate);
        dateFloor.setDate(dateFloor.getDate() - 30);
        logger.info(`Expanding dedup window to ${dateFloor.toISOString()}`);
    }

    const existingTxs = await prisma.transaction.findMany({
        where: { accountId, tenantId, transaction_date: { gte: dateFloor } },
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
        `(window: >= ${dateFloor.toISOString()})`
    );

    return hashSet;
}

module.exports = { computeTransactionHash, buildDuplicateHashSet };
