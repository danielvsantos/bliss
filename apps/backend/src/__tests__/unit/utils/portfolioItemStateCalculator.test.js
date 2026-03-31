jest.mock('../../../services/currencyService', () => ({
  getRatesForDateRange: jest.fn().mockResolvedValue(new Map()),
}));
const { getRatesForDateRange } = require('../../../services/currencyService');

const { Decimal } = require('@prisma/client/runtime/library');
const {
  calculateTotalInvested,
  calculateInvestmentState,
  calculateDebtState,
  calculatePortfolioItemState,
} = require('../../../utils/portfolioItemStateCalculator');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const buy = (debit, qty, price = 0) => ({
  debit,
  credit: null,
  assetQuantity: qty,
  assetPrice: price,
  transaction_date: new Date('2024-01-01'),
  currency: 'USD',
  category: { type: 'Investments' },
});

const sell = (credit, qty, price = 0) => ({
  debit: null,
  credit,
  assetQuantity: qty,
  assetPrice: price,
  transaction_date: new Date('2024-06-01'),
  currency: 'USD',
  category: { type: 'Investments' },
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('portfolioItemStateCalculator', () => {
  describe('calculateTotalInvested()', () => {
    it('sums debit amounts across all buy transactions', () => {
      const txs = [
        { debit: 1000, credit: null },
        { debit: 500, credit: null },
      ];
      expect(calculateTotalInvested(txs).toNumber()).toBe(1500);
    });

    it('returns Decimal(0) for an empty array', () => {
      expect(calculateTotalInvested([]).toNumber()).toBe(0);
    });

    it('ignores credit (sell) transactions', () => {
      const txs = [
        { debit: 1000, credit: null },
        { debit: null, credit: 800 },
      ];
      expect(calculateTotalInvested(txs).toNumber()).toBe(1000);
    });
  });

  describe('calculateInvestmentState()', () => {
    it('creates one lot on a single buy and returns correct cost basis', () => {
      const { costBasis, realizedPnL, quantity } = calculateInvestmentState([buy(1000, 10, 100)]);
      expect(costBasis.toNumber()).toBe(1000);
      expect(realizedPnL.toNumber()).toBe(0);
      expect(quantity.toNumber()).toBe(10);
    });

    it('partial sell (FIFO): reduces lot and realizes correct PnL', () => {
      const txs = [
        buy(1000, 10, 100),  // buy 10 @ 100
        sell(750, 5, 150),   // sell 5 @ 150 → proceeds 750, cost 500 → PnL +250
      ];
      const { costBasis, realizedPnL, quantity } = calculateInvestmentState(txs);
      expect(realizedPnL.toNumber()).toBe(250);
      expect(costBasis.toNumber()).toBe(500); // 5 remaining @ 100
      expect(quantity.toNumber()).toBe(5);
    });

    it('consumes oldest lot first (FIFO) across multiple lots', () => {
      const txs = [
        buy(500, 5, 100),    // lot1: 5 @ 100
        buy(1000, 5, 200),   // lot2: 5 @ 200
        sell(1050, 7, 150),  // sell 7 @ 150: all 5 from lot1, then 2 from lot2
      ];
      const { costBasis, realizedPnL, quantity } = calculateInvestmentState(txs);
      // lot1: 5 @ 100, proceeds 750, cost 500 → +250
      // lot2: 2 @ 200, proceeds 300, cost 400 → -100 → total PnL = 150
      expect(realizedPnL.toNumber()).toBe(150);
      expect(costBasis.toNumber()).toBe(600); // 3 remaining from lot2 @ 200
      expect(quantity.toNumber()).toBe(3);
    });

    it('defaults assetQuantity to 1 when null (manually-tracked funds)', () => {
      // Fund deposit of 50000 with no quantity/price info — should default to 1 unit
      const txs = [buy(50000, null, null)];
      const { costBasis, realizedPnL, quantity } = calculateInvestmentState(txs);
      expect(quantity.toNumber()).toBe(1);
      expect(costBasis.toNumber()).toBe(50000); // 1 unit × (50000 / 1)
      expect(realizedPnL.toNumber()).toBe(0);
    });

    it('accumulates quantity correctly for multiple deposits without assetQuantity', () => {
      const txs = [
        buy(10000, null, null),
        buy(15000, null, null),
      ];
      const { costBasis, quantity } = calculateInvestmentState(txs);
      expect(quantity.toNumber()).toBe(2);     // 1 + 1 (each deposit defaults to 1 unit)
      expect(costBasis.toNumber()).toBe(25000); // 10000 + 15000
    });

    it('_isSellAll flag empties all lots and computes correct PnL', () => {
      const txs = [
        buy(1000, 10, 100),
        // qty=0, price=0 → normalizer marks _isSellAll=true, sells entire position
        { debit: null, credit: 1200, assetQuantity: 0, assetPrice: 0 },
      ];
      const { costBasis, realizedPnL, quantity } = calculateInvestmentState(txs);
      // salePrice = 1200 / 10 = 120, cost = 100*10 = 1000, PnL = 200
      expect(realizedPnL.toNumber()).toBe(200);
      expect(costBasis.toNumber()).toBe(0);
      expect(quantity.toNumber()).toBe(0);
    });

    it('handles multiple partial withdrawals from unit-proxy item (pro-rata)', () => {
      // 3 deposits (no qty/price → each becomes 1 unit at that cost)
      // Then 3 withdrawals: 2 partial + 1 that exceeds remaining cost basis
      const txs = [
        buy(10000, null, null),  // lot1: 1 unit @ 10000
        buy(15000, null, null),  // lot2: 1 unit @ 15000
        buy(5000, null, null),   // lot3: 1 unit @ 5000
        // Total: 3 units, costBasis = 30000
        // Withdrawal 1: 6000 → ratio = 6000/30000 = 0.2 → sell 3*0.2 = 0.6 units
        { debit: null, credit: 6000, assetQuantity: null, assetPrice: null,
          transaction_date: new Date('2024-06-01'), currency: 'USD', category: { type: 'Investments' } },
        // Withdrawal 2: 6000 (partial)
        { debit: null, credit: 6000, assetQuantity: null, assetPrice: null,
          transaction_date: new Date('2024-07-01'), currency: 'USD', category: { type: 'Investments' } },
        // Withdrawal 3: 20000 (exceeds remaining cost basis → closes position)
        { debit: null, credit: 20000, assetQuantity: null, assetPrice: null,
          transaction_date: new Date('2024-08-01'), currency: 'USD', category: { type: 'Investments' } },
      ];
      const { costBasis, realizedPnL, quantity } = calculateInvestmentState(txs);
      // Total proceeds = 6000 + 6000 + 20000 = 32000
      // Total cost = 30000
      // Realized PnL should be 2000
      expect(realizedPnL.toNumber()).toBeCloseTo(2000, 2);
      expect(costBasis.toNumber()).toBeCloseTo(0, 2);
      expect(quantity.toNumber()).toBeCloseTo(0, 4);
    });

    it('single withdrawal exceeding cost basis closes entire position (unit-proxy)', () => {
      const txs = [
        buy(10000, null, null),
        buy(5000, null, null),
        // credit 20000 > costBasis 15000 → caps at totalQuantity, closes position
        { debit: null, credit: 20000, assetQuantity: null, assetPrice: null,
          transaction_date: new Date('2024-06-01'), currency: 'USD', category: { type: 'Investments' } },
      ];
      const { costBasis, realizedPnL, quantity } = calculateInvestmentState(txs);
      expect(realizedPnL.toNumber()).toBe(5000);
      expect(costBasis.toNumber()).toBe(0);
      expect(quantity.toNumber()).toBe(0);
    });

    it('withdrawal equal to cost basis closes position with zero PnL (unit-proxy)', () => {
      const txs = [
        buy(10000, null, null),
        { debit: null, credit: 10000, assetQuantity: null, assetPrice: null,
          transaction_date: new Date('2024-06-01'), currency: 'USD', category: { type: 'Investments' } },
      ];
      const { costBasis, realizedPnL, quantity } = calculateInvestmentState(txs);
      expect(realizedPnL.toNumber()).toBe(0);
      expect(costBasis.toNumber()).toBe(0);
      expect(quantity.toNumber()).toBe(0);
    });
  });

  describe('calculateDebtState()', () => {
    it('computes balance as net of debits minus credits', () => {
      const txs = [
        { debit: null, credit: 10000 }, // loan origination
        { debit: 500, credit: null },    // payment
        { debit: 300, credit: null },    // payment
      ];
      // balance = -10000 + 500 + 300 = -9200
      expect(calculateDebtState(txs).costBasis.toNumber()).toBe(-9200);
    });

    it('always returns realizedPnL of zero for debt items', () => {
      expect(calculateDebtState([{ debit: 500, credit: null }]).realizedPnL.toNumber()).toBe(0);
    });
  });

  describe('calculatePortfolioItemState()', () => {
    it('returns an empty object for an empty transactions array', async () => {
      const result = await calculatePortfolioItemState([]);
      expect(result).toEqual({});
    });

    it('routes Investments type and returns costBasis, quantity, realizedPnL', async () => {
      const result = await calculatePortfolioItemState([buy(1000, 10, 100)]);
      expect(result.costBasis.toNumber()).toBe(1000);
      expect(result.quantity.toNumber()).toBe(10);
      expect(result.realizedPnL.toNumber()).toBe(0);
      expect(result.totalInvested.toNumber()).toBe(1000);
    });

    it('computes realizedPnLInUSD using FIFO with historical FX rates', async () => {
      // BRL fund: buy 1000 BRL when BRL/USD = 0.20, sell 1200 BRL when BRL/USD = 0.25
      const buyDate = new Date('2024-01-15');
      const sellDate = new Date('2024-06-15');

      getRatesForDateRange.mockResolvedValueOnce(new Map([
        ['2024-01-15', new Decimal('0.20')],
        ['2024-06-15', new Decimal('0.25')],
      ]));

      const txs = [
        { debit: 1000, credit: null, assetQuantity: 10, assetPrice: 100,
          transaction_date: buyDate, currency: 'BRL', category: { type: 'Investments' } },
        { debit: null, credit: 1200, assetQuantity: 10, assetPrice: 120,
          transaction_date: sellDate, currency: 'BRL', category: { type: 'Investments' } },
      ];

      const result = await calculatePortfolioItemState(txs);

      // BRL PnL: 1200 - 1000 = 200 BRL
      expect(result.realizedPnL.toNumber()).toBe(200);
      // USD PnL: proceeds 1200*0.25=300 minus cost 1000*0.20=200 → 100
      expect(result.realizedPnLInUSD.toNumber()).toBe(100);
      expect(result.totalInvestedInUSD.toNumber()).toBe(200); // 1000 * 0.20
      expect(result.costBasisInUSD.toNumber()).toBe(0); // all sold
    });

    it('computes realizedPnLInUSD with FIFO across multiple lots at different rates', async () => {
      const date1 = new Date('2024-01-15');
      const date2 = new Date('2024-03-15');
      const sellDate = new Date('2024-06-15');

      getRatesForDateRange.mockResolvedValueOnce(new Map([
        ['2024-01-15', new Decimal('0.20')],
        ['2024-03-15', new Decimal('0.18')],
        ['2024-06-15', new Decimal('0.25')],
      ]));

      const txs = [
        { debit: 500, credit: null, assetQuantity: 5, assetPrice: 100,
          transaction_date: date1, currency: 'BRL', category: { type: 'Investments' } },
        { debit: 1000, credit: null, assetQuantity: 5, assetPrice: 200,
          transaction_date: date2, currency: 'BRL', category: { type: 'Investments' } },
        { debit: null, credit: 1050, assetQuantity: 7, assetPrice: 150,
          transaction_date: sellDate, currency: 'BRL', category: { type: 'Investments' } },
      ];

      const result = await calculatePortfolioItemState(txs);

      // BRL PnL (FIFO): lot1 5@100: proceeds 750, cost 500 → +250
      //                  lot2 2@200: proceeds 300, cost 400 → -100 → total 150
      expect(result.realizedPnL.toNumber()).toBe(150);

      // USD PnL (FIFO with historical rates):
      // lot1 5 units: cost 500*0.20=100, proceeds 750*0.25=187.5 → +87.5
      // lot2 2 units: cost 400*0.18=72, proceeds 300*0.25=75 → +3
      // Total = 90.5
      expect(result.realizedPnLInUSD.toNumber()).toBe(90.5);

      // Remaining: 3 units from lot2 @ 200 BRL, rate 0.18
      // costBasisInUSD = 3 * 200 * 0.18 = 108
      expect(result.costBasisInUSD.toNumber()).toBe(108);
    });

    it('computes realizedPnLInUSD correctly for manual fund with _isSellAll', async () => {
      // Simulates the user's PIC Itaú scenario: manual fund, no qty/price, full redemption
      const buyDate1 = new Date('2024-01-15');
      const buyDate2 = new Date('2024-02-15');
      const sellDate = new Date('2024-06-15');

      getRatesForDateRange.mockResolvedValueOnce(new Map([
        ['2024-01-15', new Decimal('0.20')],
        ['2024-02-15', new Decimal('0.19')],
        ['2024-06-15', new Decimal('0.25')],
      ]));

      const txs = [
        { debit: 1000, credit: null, assetQuantity: null, assetPrice: null,
          transaction_date: buyDate1, currency: 'BRL', category: { type: 'Investments' } },
        { debit: 500, credit: null, assetQuantity: null, assetPrice: null,
          transaction_date: buyDate2, currency: 'BRL', category: { type: 'Investments' } },
        // Redemption: no qty/price → normalizer sets _isSellAll
        { debit: null, credit: 1600, assetQuantity: null, assetPrice: null,
          transaction_date: sellDate, currency: 'BRL', category: { type: 'Investments' } },
      ];

      const result = await calculatePortfolioItemState(txs);

      // BRL PnL: Each buy = 1 unit. Total 2 units. salePrice = 1600/2 = 800/unit
      // lot1: proceeds 800, cost 1000 → -200
      // lot2: proceeds 800, cost 500  → +300 → total = 100
      expect(result.realizedPnL.toNumber()).toBe(100);

      // USD PnL:
      // lot1: cost 1000*0.20=200, proceeds 800*0.25=200 → 0
      // lot2: cost 500*0.19=95,   proceeds 800*0.25=200 → +105
      // Total = 105
      expect(result.realizedPnLInUSD.toNumber()).toBe(105);
      expect(result.costBasisInUSD.toNumber()).toBe(0); // all sold
      expect(result.quantity.toNumber()).toBe(0);
    });

    it('converts foreign-currency transactions to the portfolio item currency before FIFO', async () => {
      // Portfolio item currency is EUR (from first transaction).
      // One BRL buy gets converted to EUR using cross-rate derived via USD.
      const buyDate1 = new Date('2024-01-15');
      const buyDateBRL = new Date('2024-03-15');
      const sellDate = new Date('2024-06-15');

      // getRatesForDateRange is called once for EUR→USD, once for BRL→USD
      getRatesForDateRange
        .mockResolvedValueOnce(new Map([
          // EUR→USD rates
          ['2024-01-15', new Decimal('1.10')],
          ['2024-03-15', new Decimal('1.10')],
          ['2024-06-15', new Decimal('1.10')],
        ]))
        .mockResolvedValueOnce(new Map([
          // BRL→USD rates
          ['2024-03-15', new Decimal('0.20')],
        ]));

      const txs = [
        // EUR buy: 1000 EUR, qty=1000, price=1
        { debit: 1000, credit: null, assetQuantity: 1000, assetPrice: 1,
          transaction_date: buyDate1, currency: 'EUR', category: { type: 'Investments' } },
        // BRL buy: 5500 BRL, qty=5000, price=1.1 BRL
        // Cross-rate: BRL→EUR = BRL→USD / EUR→USD = 0.20 / 1.10 ≈ 0.18182
        // Converted: debit = 5500 * 0.18182 = 1000 EUR, price = 1.1 * 0.18182 ≈ 0.2 EUR
        { debit: 5500, credit: null, assetQuantity: 5000, assetPrice: 1.1,
          transaction_date: buyDateBRL, currency: 'BRL', category: { type: 'Investments' } },
        // EUR sell: sell all 6000 units for 2200 EUR
        { debit: null, credit: 2200, assetQuantity: 6000, assetPrice: null,
          transaction_date: sellDate, currency: 'EUR', category: { type: 'Investments' } },
      ];

      const result = await calculatePortfolioItemState(txs);

      // BRL 5500 * (0.20 / 1.10) = 1000 EUR equivalent
      // Total cost basis: 1000 (EUR lot) + 1000 (BRL→EUR lot) = 2000 EUR
      // Proceeds: 2200 EUR
      // Realized PnL: 2200 - 2000 = 200 EUR
      expect(result.realizedPnL.toNumber()).toBeCloseTo(200, 0);
      expect(result.costBasis.toNumber()).toBeCloseTo(0, 2);
      expect(result.quantity.toNumber()).toBe(0);
      // Total invested: 1000 + 1000 = 2000 EUR
      expect(result.totalInvested.toNumber()).toBeCloseTo(2000, 0);
    });
  });
});
