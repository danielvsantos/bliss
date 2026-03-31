const { isBuyTransaction, isSellTransaction, normalizeTransaction } = require('../../../utils/transactionNormalizer');
const { Decimal } = require('@prisma/client/runtime/library');

describe('transactionNormalizer', () => {
  describe('isBuyTransaction()', () => {
    it('returns true when debit is a positive number', () => {
      expect(isBuyTransaction({ debit: 100 })).toBe(true);
      expect(isBuyTransaction({ debit: '500.50' })).toBe(true);
    });

    it('returns falsy when debit is zero or absent', () => {
      expect(isBuyTransaction({ debit: 0 })).toBeFalsy();
      expect(isBuyTransaction({ debit: null })).toBeFalsy();
      expect(isBuyTransaction({ debit: undefined })).toBeFalsy();
      expect(isBuyTransaction({ credit: 100 })).toBeFalsy();
    });
  });

  describe('isSellTransaction()', () => {
    it('returns true when credit is a positive number', () => {
      expect(isSellTransaction({ credit: 200 })).toBe(true);
      expect(isSellTransaction({ credit: '300.00' })).toBe(true);
    });

    it('returns falsy when credit is zero or absent', () => {
      expect(isSellTransaction({ credit: 0 })).toBeFalsy();
      expect(isSellTransaction({ credit: null })).toBeFalsy();
      expect(isSellTransaction({ debit: 100 })).toBeFalsy();
    });
  });

  describe('normalizeTransaction()', () => {
    it('does not mutate the original transaction object', () => {
      const original = { debit: 1000, credit: null, assetQuantity: 0, assetPrice: 0 };
      const frozen = Object.freeze({ ...original });
      // Should not throw even if we try to mutate a frozen object
      expect(() => normalizeTransaction(frozen)).not.toThrow();
      // Original is unchanged
      expect(original.assetQuantity).toBe(0);
    });

    it('returns transaction unchanged when quantity is already set', () => {
      const tx = { debit: 1000, credit: null, assetQuantity: 10, assetPrice: 100 };
      const result = normalizeTransaction(tx);
      expect(result).toBe(tx); // same reference
    });

    it('calculates quantity from debit ÷ price when price is known (buy)', () => {
      const tx = { debit: 1000, credit: null, assetQuantity: 0, assetPrice: 200 };
      const result = normalizeTransaction(tx);
      expect(new Decimal(result.assetQuantity).toNumber()).toBe(5); // 1000 / 200
      expect(result._isSellAll).toBeUndefined();
    });

    it('calculates quantity from credit ÷ price when price is known (sell)', () => {
      const tx = { debit: null, credit: 500, assetQuantity: 0, assetPrice: 100 };
      const result = normalizeTransaction(tx);
      expect(new Decimal(result.assetQuantity).toNumber()).toBe(5); // 500 / 100
      expect(result._isSellAll).toBeUndefined();
    });

    it('defaults buy quantity to 1 when price is unknown', () => {
      const tx = { debit: 1000, credit: null, assetQuantity: 0, assetPrice: 0 };
      const result = normalizeTransaction(tx);
      expect(new Decimal(result.assetQuantity).toNumber()).toBe(1);
      expect(result._isSellAll).toBeUndefined();
    });

    it('defaults sell quantity to 1 and sets _isSellAll when price is unknown', () => {
      const tx = { debit: null, credit: 500, assetQuantity: 0, assetPrice: 0 };
      const result = normalizeTransaction(tx);
      expect(new Decimal(result.assetQuantity).toNumber()).toBe(1);
      expect(result._isSellAll).toBe(true);
    });
  });
});
