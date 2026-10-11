/**
 * Enable Banking → PlaidTransaction mapping (#132, R11 / R10).
 */

jest.mock('../../../../utils/encryption', () => ({
    encrypt: jest.fn((v) => `enc:${v}`),
}));

const {
    mapEnableBankingTransaction,
    transactionKey,
    remittanceText,
} = require('../../../../services/enableBanking/mapper');

const HASH = 'idhash-4704';

function tx(overrides = {}) {
    return {
        entry_reference: 'ref-1',
        transaction_id: null,
        status: 'BOOK',
        credit_debit_indicator: 'DBIT',
        transaction_amount: { amount: '10.70', currency: 'EUR' },
        booking_date: '2026-10-10',
        value_date: '2026-10-11',
        transaction_date: '2026-10-09',
        remittance_information: ['Taxi Lic 1137'],
        creditor: { name: 'TAXI LIC 1137 BARCELONA' },
        debtor: null,
        bank_transaction_code: { code: 'CARD_PAYMENT', description: 'Card payment' },
        ...overrides,
    };
}

describe('mapEnableBankingTransaction', () => {
    it('maps a DBIT card payment as a positive (money-out) amount on the booking date', () => {
        const row = mapEnableBankingTransaction('item-1', HASH, tx());
        expect(row).toMatchObject({
            plaidItemId: 'item-1',
            plaidAccountId: `eb:${HASH}`,
            plaidTransactionId: `eb:${HASH}:ref-1`,
            amount: 10.7,
            name: 'Taxi Lic 1137',
            merchantName: 'TAXI LIC 1137 BARCELONA',
            isoCurrencyCode: 'EUR',
            category: 'CARD_PAYMENT',
            pending: false,
            paymentChannel: null,
            syncType: 'ADDED',
            processed: false,
        });
        expect(row.date.toISOString().slice(0, 10)).toBe('2026-10-10');
        expect(row.rawJson).toMatch(/^enc:/);
        expect(JSON.parse(row.rawJson.slice(4)).entry_reference).toBe('ref-1');
    });

    it('maps a CRDT as negative (money in) with the debtor as merchant', () => {
        const row = mapEnableBankingTransaction('item-1', HASH, tx({
            credit_debit_indicator: 'CRDT',
            transaction_amount: { amount: '50.00', currency: 'EUR' },
            remittance_information: ['Bizum de Patricia'],
            creditor: null,
            debtor: { name: 'Patricia' },
        }));
        expect(row.amount).toBe(-50);
        expect(row.merchantName).toBe('Patricia');
    });

    it('joins multi-line remittance text with " - "', () => {
        expect(remittanceText(tx({ remittance_information: ['Turris Calvet 2', ' Barcelona ', ''] })))
            .toBe('Turris Calvet 2 - Barcelona');
        const row = mapEnableBankingTransaction('i', HASH, tx({ remittance_information: ['a', 'b'] }));
        expect(row.name).toBe('a - b');
    });

    it('falls back to value_date then transaction_date for the date', () => {
        expect(mapEnableBankingTransaction('i', HASH, tx({ booking_date: null })).date.toISOString().slice(0, 10)).toBe('2026-10-11');
        expect(mapEnableBankingTransaction('i', HASH, tx({ booking_date: null, value_date: null })).date.toISOString().slice(0, 10)).toBe('2026-10-09');
    });

    it('falls back to the counterparty name, then the bank code description, for the name', () => {
        expect(mapEnableBankingTransaction('i', HASH, tx({ remittance_information: [] })).name).toBe('TAXI LIC 1137 BARCELONA');
        expect(mapEnableBankingTransaction('i', HASH, tx({ remittance_information: [], creditor: null })).name).toBe('Card payment');
    });

    it('returns null for pending (PDNG) and unusable rows', () => {
        expect(mapEnableBankingTransaction('i', HASH, tx({ status: 'PDNG' }))).toBeNull();
        expect(mapEnableBankingTransaction('i', HASH, tx({ booking_date: null, value_date: null, transaction_date: null }))).toBeNull();
        expect(mapEnableBankingTransaction('i', HASH, tx({ transaction_amount: { amount: 'abc' } }))).toBeNull();
    });
});

describe('transactionKey (R10)', () => {
    it('keys on (identification_hash, entry_reference)', () => {
        expect(transactionKey(HASH, tx())).toEqual({ key: `eb:${HASH}:ref-1`, fallback: false });
        // The same entry_reference on another account is a different key.
        expect(transactionKey('other', tx()).key).not.toBe(transactionKey(HASH, tx()).key);
    });

    it('uses a deterministic fingerprint when entry_reference is missing', () => {
        const a = transactionKey(HASH, tx({ entry_reference: null }));
        const b = transactionKey(HASH, tx({ entry_reference: '  ' }));
        expect(a.fallback).toBe(true);
        expect(a.key).toMatch(new RegExp(`^eb:${HASH}:fp:[0-9a-f]{64}$`));
        expect(b.key).toBe(a.key);
        expect(transactionKey(HASH, tx({ entry_reference: null, transaction_amount: { amount: '10.71', currency: 'EUR' } })).key)
            .not.toBe(a.key);
    });
});
