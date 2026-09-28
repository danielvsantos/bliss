// ─── builder.test.js ──────────────────────────────────────────────────────────
// Snapshot-style tests on the layered prompt builder. Confirms each layer
// (L1 identity, L2 tier, L3 lens rubrics, L4 examples) lands in the right
// system block and that active-lens filtering at injection time produces
// only the lenses the run will actually consume.

const {
  buildSystemBlocks,
  buildSystemString,
  buildUserMessage,
} = require('../../../../services/insightPrompts/builder');

const baseTenantData = {
  tier: 'MONTHLY',
  portfolioCurrency: 'USD',
  targetPeriod: '2026-03',
  comparisonAvailable: { prior: true, yoy: true },
  hasTransactions: true,
  months: ['2025-12', '2026-01', '2026-02', '2026-03'],
  monthlyData: {
    '2026-03': { income: 9200, expenses: 4210, groups: { Dining: 612, Housing: 1800 } },
    '2026-02': { income: 9200, expenses: 4260, groups: { Dining: 380, Housing: 1800 } },
    '2026-01': { income: 9200, expenses: 4180, groups: { Dining: 350, Housing: 1800 } },
    '2025-12': { income: 9200, expenses: 4220, groups: { Dining: 360, Housing: 1800 } },
  },
  netWorthHistory: [
    { date: '2025-09-01', value: 218000 },
    { date: '2026-03-01', value: 242000 },
  ],
  incomeHistory: [
    { month: '2025-09', income: 9100 },
    { month: '2025-10', income: 9200 },
    { month: '2025-11', income: 9200 },
    { month: '2025-12', income: 9200 },
    { month: '2026-01', income: 9200 },
    { month: '2026-02', income: 9200 },
    { month: '2026-03', income: 9200 },
  ],
  savingsHistory: [
    { month: '2025-09', savings: 4000 },
    { month: '2025-10', savings: 4100 },
    { month: '2025-11', savings: 4200 },
    { month: '2025-12', savings: 4980 },
    { month: '2026-01', savings: 5020 },
    { month: '2026-02', savings: 4940 },
    { month: '2026-03', savings: 4990 },
  ],
};

describe('insightPrompts/builder', () => {
  describe('buildSystemBlocks()', () => {
    it('returns four ordered blocks (identity, tier, lenses, examples)', () => {
      const blocks = buildSystemBlocks('MONTHLY', ['SPENDING_VELOCITY', 'SAVINGS_RATE']);
      expect(blocks).toHaveLength(4);
      expect(blocks.map((b) => b.kind)).toEqual(['identity', 'tier', 'lenses', 'examples']);
    });

    it('identity block contains the L1 fiduciary + voice + global readership content', () => {
      const [identity] = buildSystemBlocks('MONTHLY', ['SPENDING_VELOCITY']);
      expect(identity.text).toMatch(/FIDUCIARY PRINCIPLE/);
      expect(identity.text).toMatch(/GLOBAL READERSHIP/);
      expect(identity.text).toMatch(/CFP \(Certified Financial Planner\)/);
      expect(identity.text).toMatch(/CRITICAL severity is reserved for genuinely bad news/);
    });

    it('tier block reflects the tier-specific length and comparison rules', () => {
      const [, tier] = buildSystemBlocks('MONTHLY', ['SPENDING_VELOCITY']);
      expect(tier.text).toMatch(/Monthly review/);
      expect(tier.text).toMatch(/2-3 sentences/);
    });

    it('lenses block only includes rubrics for the active lenses', () => {
      const [, , lenses] = buildSystemBlocks('MONTHLY', ['SPENDING_VELOCITY', 'SAVINGS_RATE']);
      expect(lenses.text).toMatch(/SPENDING_VELOCITY/);
      expect(lenses.text).toMatch(/SAVINGS_RATE/);
      // Lenses NOT in the active set must not appear in the rubrics block
      expect(lenses.text).not.toMatch(/SECTOR_CONCENTRATION/);
      expect(lenses.text).not.toMatch(/DIVIDEND_OPPORTUNITY/);
    });

    it('examples block injects only the example for each active lens', () => {
      const [, , , examples] = buildSystemBlocks('MONTHLY', ['SPENDING_VELOCITY']);
      // Should reference the lens that fired
      expect(examples.text).toMatch(/SPENDING_VELOCITY/);
      // Should NOT reference an inactive lens's example
      expect(examples.text).not.toMatch(/INCOME_DIVERSIFICATION/);
    });

    it('returns three blocks (no examples) when no examples exist for the lens-set', () => {
      // PORTFOLIO tier has only 4 examples; pick a lens that doesn't exist in
      // any tier example map to verify the builder gracefully drops the L4 block.
      const blocks = buildSystemBlocks('MONTHLY', ['DIVIDEND_OPPORTUNITY']);
      // DIVIDEND_OPPORTUNITY isn't in monthly.examples, so the examples block
      // shrinks. Lens block still appears because we ship the rubric.
      const kinds = blocks.map((b) => b.kind);
      expect(kinds).toContain('lenses');
      expect(kinds).not.toContain('examples');
    });

    it('emits empty-list-friendly output when activeLenses is empty', () => {
      const blocks = buildSystemBlocks('MONTHLY', []);
      // Identity + tier always land; lenses + examples are skipped when nothing active.
      expect(blocks.map((b) => b.kind)).toEqual(['identity', 'tier']);
    });
  });

  describe('buildSystemString()', () => {
    it('concatenates all blocks with newline separators in order', () => {
      const blocks = buildSystemBlocks('MONTHLY', ['SPENDING_VELOCITY']);
      const string = buildSystemString('MONTHLY', ['SPENDING_VELOCITY']);
      expect(string).toBe(blocks.map((b) => b.text).join('\n\n'));
    });
  });

  describe('buildUserMessage()', () => {
    it('includes period, comparison availability, KEY SIGNALS, and FINANCIAL DATA sections', () => {
      const message = buildUserMessage('MONTHLY', baseTenantData, ['SPENDING_VELOCITY']);
      expect(message).toMatch(/PERIOD: 2026-03/);
      expect(message).toMatch(/PORTFOLIO CURRENCY: USD/);
      expect(message).toMatch(/COMPARISON DATA AVAILABILITY:/);
      expect(message).toMatch(/KEY SIGNALS \(pre-computed/);
      expect(message).toMatch(/FINANCIAL DATA \(raw context/);
      expect(message).toMatch(/ACTIVE LENSES/);
    });

    it('lists active lenses verbatim in the order they were passed', () => {
      const message = buildUserMessage('MONTHLY', baseTenantData, ['SAVINGS_RATE', 'SPENDING_VELOCITY']);
      expect(message).toMatch(/ACTIVE LENSES \(produce exactly one insight per lens, in this order\):\nSAVINGS_RATE, SPENDING_VELOCITY/);
    });

    it('strips internal flags (hasTransactions / tier) from FINANCIAL DATA', () => {
      // Note: KEY SIGNALS legitimately contains a comparisonAvailable field —
      // that's a feature, not a leak. We only assert here that derived/
      // internal flags don't leak into the raw FINANCIAL DATA dump.
      const message = buildUserMessage('MONTHLY', baseTenantData, ['SPENDING_VELOCITY']);
      const financialDataSection = message.split('FINANCIAL DATA (raw context')[1] || '';
      expect(financialDataSection).not.toMatch(/"hasTransactions":/);
      expect(financialDataSection).not.toMatch(/"tier":\s*"MONTHLY"/);
      expect(financialDataSection).not.toMatch(/"comparisonAvailable":/);
    });
  });

  // ── Passive income & asset class awareness (#80) ──────────────────────────
  describe('PASSIVE_INCOME_OUTLOOK', () => {
    it.each(['PORTFOLIO', 'QUARTERLY', 'ANNUAL'])('%s: rubric and example included only when the lens is active', (tier) => {
      const withLens = buildSystemBlocks(tier, ['PASSIVE_INCOME_OUTLOOK']);
      const lenses = withLens.find((b) => b.kind === 'lenses').text;
      const examples = withLens.find((b) => b.kind === 'examples').text;
      expect(lenses).toMatch(/PASSIVE_INCOME_OUTLOOK/);
      expect(lenses).toMatch(/GROSS/);
      expect(lenses).toMatch(/NON-investment income/);
      expect(examples).toMatch(/"lens": "PASSIVE_INCOME_OUTLOOK"/);

      const without = buildSystemString(tier, tier === 'PORTFOLIO' ? ['DIVIDEND_OPPORTUNITY'] : ['SAVINGS_RATE']);
      expect(without).not.toMatch(/PASSIVE_INCOME_OUTLOOK\nFocus/);
      expect(without).not.toMatch(/"lens": "PASSIVE_INCOME_OUTLOOK"/);
    });

    it('rubric covers the severity triggers and the setup action', () => {
      const text = buildSystemString('QUARTERLY', ['PASSIVE_INCOME_OUTLOOK']);
      expect(text).toMatch(/endingIncomeWarning/);
      expect(text).toMatch(/singleSourceWarning/);
      expect(text).toMatch(/coverageMilestoneCrossed/);
      expect(text).toMatch(/PASSIVE_INCOME_SETUP/);
    });

    it('examples cover a WARNING (ending income) and a POSITIVE (coverage milestone)', () => {
      const portfolio = buildSystemString('PORTFOLIO', ['PASSIVE_INCOME_OUTLOOK']);
      const quarterly = buildSystemString('QUARTERLY', ['PASSIVE_INCOME_OUTLOOK']);
      expect(portfolio).toMatch(/PASSIVE_INCOME_OUTLOOK \(WARNING\)/);
      expect(quarterly).toMatch(/PASSIVE_INCOME_OUTLOOK \(POSITIVE\)/);
    });
  });

  describe('updated portfolio rubrics', () => {
    it('DIVIDEND_OPPORTUNITY quotes the engine figure instead of deriving one from yields', () => {
      const text = buildSystemString('PORTFOLIO', ['DIVIDEND_OPPORTUNITY']);
      expect(text).toMatch(/dividendsNext12m/);
      expect(text).toMatch(/never write "trailing yield implies/);
      expect(text).not.toMatch(/Frame projections as "trailing yield implies/);
    });

    it('SECTOR_CONCENTRATION describes look-through and never flags non-equity buckets', () => {
      const text = buildSystemString('PORTFOLIO', ['SECTOR_CONCENTRATION']);
      expect(text).toMatch(/only when Bliss has its composition/);
      expect(text).toMatch(/unclassifiedSharePct/);
      expect(text).toMatch(/NEVER flag them/);
    });

    it('PORTFOLIO_EXPOSURE uses asset classes and fixed income; VALUATION_RISK is stocks-only', () => {
      const text = buildSystemString('PORTFOLIO', ['PORTFOLIO_EXPOSURE', 'VALUATION_RISK']);
      expect(text).toMatch(/assetClassAllocation/);
      expect(text).toMatch(/fixedIncome/);
      expect(text).toMatch(/ETFs never carry a P\/E/);
    });
  });

  describe('buildUserMessage() — passive income', () => {
    it('puts the passive income summary in KEY SIGNALS only (not twice)', () => {
      const data = {
        tier: 'QUARTERLY',
        targetPeriod: '2026-Q3',
        monthlyData: {},
        months: [],
        quarterTotals: { income: 1, expenses: 0, groups: {} },
        passiveIncome: { next12m: { total: 1234 }, coverage: { pct: 100 }, endingWithin12m: {} },
        incomeMix: { passiveIncomeSharePct: 4 },
      };
      const message = buildUserMessage('QUARTERLY', data, ['PASSIVE_INCOME_OUTLOOK']);
      const [keySignals, financialData] = message.split('FINANCIAL DATA (raw context');
      expect(keySignals).toMatch(/"total": 1234/);
      expect(keySignals).toMatch(/"passiveIncomeSharePct": 4/);
      expect(financialData).not.toMatch(/passiveIncome/);
      expect(financialData).not.toMatch(/incomeMix/);
    });
  });
});
