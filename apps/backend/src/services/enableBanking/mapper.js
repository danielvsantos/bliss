/**
 * Enable Banking transaction → PlaidTransaction create payload (#132, R11).
 *
 * Pure apart from `encrypt` for rawJson (same as mapPlaidTransaction). Rows are
 * written in Plaid's conventions so the processor, review queue, promote routes
 * and MCP tools work unchanged:
 *   - amount: positive = money out (DBIT → +amount, CRDT → −amount)
 *   - plaidAccountId / plaidTransactionId: synthetic keys from the stable
 *     identification_hash (decision D2), so reconnects never re-key history.
 */

const crypto = require('crypto');
const {
    ebAccountKey,
    ebTransactionKey,
    ebFingerprintKey,
} = require('@bliss/shared/enablebanking');
const { encrypt } = require('../../utils/encryption');

const BOOKED = 'BOOK';

function remittanceText(tx) {
    const lines = Array.isArray(tx.remittance_information)
        ? tx.remittance_information
        : (tx.remittance_information ? [tx.remittance_information] : []);
    return lines.map((l) => String(l).trim()).filter(Boolean).join(' - ');
}

function counterpartyName(tx) {
    const party = tx.credit_debit_indicator === 'CRDT' ? tx.debtor : tx.creditor;
    return party?.name ? String(party.name).trim() || null : null;
}

/** booking_date → value_date → transaction_date (spike-verified, R11). */
function transactionDate(tx) {
    return tx.booking_date || tx.value_date || tx.transaction_date || null;
}

/** sha256 of the fields that identify a transaction when entry_reference is missing (R10). */
function fingerprint(tx) {
    const parts = [
        transactionDate(tx) || '',
        tx.transaction_amount?.amount ?? '',
        tx.credit_debit_indicator || '',
        remittanceText(tx),
        counterpartyName(tx) || '',
    ];
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

/**
 * Stable dedupe key for one transaction of one bank account.
 * @returns {{ key: string, fallback: boolean }}
 */
function transactionKey(identificationHash, tx) {
    const ref = typeof tx.entry_reference === 'string' ? tx.entry_reference.trim() : '';
    if (ref) return { key: ebTransactionKey(identificationHash, ref), fallback: false };
    return { key: ebFingerprintKey(identificationHash, fingerprint(tx)), fallback: true };
}

/**
 * @returns {object | null} the create payload, or null for a non-booked
 *   (pending) transaction or one without a usable date / amount.
 */
function mapEnableBankingTransaction(plaidItemId, identificationHash, tx) {
    if (!tx || tx.status !== BOOKED) return null;
    const date = transactionDate(tx);
    const rawAmount = Number(tx.transaction_amount?.amount);
    if (!date || !Number.isFinite(rawAmount)) return null;

    const magnitude = Math.abs(rawAmount);
    // Plaid convention: positive = money out. Anything that is not an explicit
    // credit is treated as a debit, which is what the indicator defaults to.
    const amount = tx.credit_debit_indicator === 'CRDT' ? -magnitude : magnitude;
    const counterparty = counterpartyName(tx);
    const name = remittanceText(tx)
        || counterparty
        || tx.bank_transaction_code?.description
        || 'Bank transaction';
    const { key } = transactionKey(identificationHash, tx);

    return {
        plaidItemId,
        plaidAccountId: ebAccountKey(identificationHash),
        plaidTransactionId: key,
        amount,
        date: new Date(date),
        authorizedDate: tx.transaction_date ? new Date(tx.transaction_date) : null,
        name,
        merchantName: counterparty,
        paymentChannel: null,
        isoCurrencyCode: tx.transaction_amount?.currency || null,
        pending: false,
        category: tx.bank_transaction_code?.code || null,
        pendingTransactionId: null,
        syncType: 'ADDED',
        processed: false,
        rawJson: encrypt(JSON.stringify(tx)),
    };
}

module.exports = {
    mapEnableBankingTransaction,
    transactionKey,
    remittanceText,
    counterpartyName,
    transactionDate,
    fingerprint,
};
