jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const logger = require('../../../utils/logger');
const { PRIORITIES } = require('../../../config/twelveDataCredits');
const budgetModule = require('../../../utils/twelveDataBudget');

const { createTwelveDataBudget } = budgetModule;

/** An ioredis-like client whose scripts always fail (Redis down / timeout). */
function brokenRedis() {
  const client = {
    defineCommand: jest.fn((name) => {
      client[name] = jest.fn(() => Promise.reject(new Error('Command timed out')));
    }),
  };
  return client;
}

const fallbackWarnings = () => logger.warn.mock.calls.filter(([msg]) => msg === 'twelve_data_budget_fallback');

describe('twelveDataBudget', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    budgetModule.__setClientForTests(undefined);
  });

  describe('in-process window (no shared store)', () => {
    it('grants within the limit and makes the next caller wait for the window', async () => {
      const budget = createTwelveDataBudget({ redis: null, limit: 10, windowMs: 200, pollCapMs: 50 });

      const first = await budget.acquire({ endpoint: 'profile', credits: 10, priority: PRIORITIES.VALUATION });
      expect(first).toMatchObject({ credits: 10, mode: 'local' });
      expect(first.waitedMs).toBeLessThan(50);

      const second = await budget.acquire({ endpoint: 'quote', credits: 1, priority: PRIORITIES.VALUATION });
      expect(second.waitedMs).toBeGreaterThanOrEqual(150);
    });

    it('clamps a call costing more than the limit so it never deadlocks', async () => {
      const budget = createTwelveDataBudget({ redis: null, limit: 8, windowMs: 100, pollCapMs: 20 });
      const r = await budget.acquire({ endpoint: 'earnings', credits: 20, priority: PRIORITIES.FUNDAMENTALS });
      expect(r.credits).toBe(8);
    });

    it('serves a waiting higher priority before a lower one', async () => {
      const budget = createTwelveDataBudget({ redis: null, limit: 2, windowMs: 150, pollCapMs: 10 });
      await budget.acquire({ endpoint: 'quote', credits: 2, priority: PRIORITIES.VALUATION });

      const order = [];
      const background = budget.acquire({ endpoint: 'quote', credits: 2, priority: PRIORITIES.BACKGROUND })
        .then(() => order.push('background'));
      await new Promise((r) => setTimeout(r, 15));
      const interactive = budget.acquire({ endpoint: 'quote', credits: 2, priority: PRIORITIES.INTERACTIVE })
        .then(() => order.push('interactive'));

      await Promise.all([background, interactive]);
      expect(order).toEqual(['interactive', 'background']);
    });

    it('holds every caller during a pause', async () => {
      const budget = createTwelveDataBudget({ redis: null, limit: 100, windowMs: 1000, pollCapMs: 20 });
      budget.pause(80);
      const r = await budget.acquire({ endpoint: 'quote', credits: 1, priority: PRIORITIES.INTERACTIVE });
      expect(r.waitedMs).toBeGreaterThanOrEqual(70);
    });
  });

  describe('Redis unavailable', () => {
    it('never rejects: falls back to a conservative in-process share of the limit', async () => {
      const redis = brokenRedis();
      const budget = createTwelveDataBudget({ redis, limit: 377, windowMs: 60_000, pollCapMs: 20 });

      const r = await budget.acquire({ endpoint: 'quote', credits: 1, priority: PRIORITIES.VALUATION });

      expect(r.mode).toBe('fallback');
      expect(redis.tdBudgetAcquire).toHaveBeenCalledTimes(1);
      // floor(377 × 0.25) = 94 credits/min in fallback
      for (let i = 0; i < 93; i++) {
        await budget.acquire({ endpoint: 'quote', credits: 1, priority: PRIORITIES.VALUATION });
      }
      expect(budget.localUsed()).toBe(94);
      const blocked = await Promise.race([
        budget.acquire({ endpoint: 'quote', credits: 1, priority: PRIORITIES.VALUATION }).then(() => 'granted'),
        new Promise((r) => setTimeout(() => r('waiting'), 60)),
      ]);
      expect(blocked).toBe('waiting');
    });

    it('warns once per fallback period, not once per call, and skips Redis meanwhile', async () => {
      const redis = brokenRedis();
      const budget = createTwelveDataBudget({ redis, limit: 377, pollCapMs: 20 });

      for (let i = 0; i < 5; i++) {
        await budget.acquire({ endpoint: 'quote', credits: 1, priority: PRIORITIES.VALUATION });
      }

      expect(fallbackWarnings()).toHaveLength(1);
      expect(fallbackWarnings()[0][1]).toMatchObject({ fallbackLimit: 94, error: 'Command timed out' });
      expect(redis.tdBudgetAcquire).toHaveBeenCalledTimes(1);
    });

    it('pause never throws even when Redis is broken', () => {
      const budget = createTwelveDataBudget({ redis: brokenRedis(), limit: 10 });
      expect(() => budget.pause(1000)).not.toThrow();
    });
  });

  describe('default instance', () => {
    it('is bypassed in unit tests unless a client is injected', async () => {
      const r = await budgetModule.acquire({ endpoint: 'quote', credits: 1, priority: PRIORITIES.VALUATION });
      expect(r).toMatchObject({ mode: 'disabled', waitedMs: 0 });
      expect(() => budgetModule.pause(10)).not.toThrow();
    });

    it('uses the injected client once one is set', async () => {
      budgetModule.__setClientForTests(null, { limit: 5 });
      const r = await budgetModule.acquire({ endpoint: 'quote', credits: 1, priority: PRIORITIES.VALUATION });
      expect(r.mode).toBe('local');
    });

    it('closes cleanly when no connection was opened', async () => {
      await expect(budgetModule.closeTwelveDataBudget()).resolves.toBeUndefined();
    });
  });
});
