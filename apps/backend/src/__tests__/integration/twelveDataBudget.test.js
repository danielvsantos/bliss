/**
 * Integration test: the shared Twelve Data credit budget (#150) against a real
 * Redis. Each budget client gets its own ioredis connection, standing in for
 * the separate web and worker processes. The window is compressed (hundreds of
 * ms instead of 60 s) through the injectable `windowMs`; the Lua logic is the
 * same. Keys live under a per-run prefix, so a shared REDIS_URL is safe.
 */

const IORedis = require('ioredis');
const { createTwelveDataBudget } = require('../../utils/twelveDataBudget');
const { PRIORITIES } = require('../../config/twelveDataCredits');

const RUN = `test-td-budget-${process.pid}-${Date.now()}`;
const connections = [];
let reader;
let testIndex = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  const c = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
  connections.push(c);
  return c;
}

/** A budget on its own connection (one "process"). */
function processBudget(prefix, opts) {
  return createTwelveDataBudget({ redis: connect(), keyPrefix: prefix, ...opts });
}

beforeAll(() => {
  reader = connect();
});

afterAll(async () => {
  const keys = await reader.keys(`${RUN}:*`);
  if (keys.length) await reader.del(...keys);
  await Promise.all(connections.map((c) => c.quit().catch(() => c.disconnect())));
});

let prefix;
beforeEach(() => {
  testIndex += 1;
  prefix = `${RUN}:${testIndex}`;
});

describe('shared Twelve Data credit budget (real Redis)', () => {
  it('never exceeds the limit in any rolling window with mixed costs and priorities running at once', async () => {
    const LIMIT = 50;
    const WINDOW = 1000;
    const opts = { limit: LIMIT, windowMs: WINDOW, pollCapMs: 50 };
    const grants = []; // { at, credits }

    const loop = async (budget, credits, priority, untilMs) => {
      while (Date.now() < untilMs) {
        const r = await budget.acquire({ endpoint: 'x', credits, priority });
        grants.push({ at: Date.now(), credits: r.credits });
      }
    };

    const until = Date.now() + 3500;
    await Promise.all([
      loop(processBudget(prefix, opts), 1, PRIORITIES.VALUATION, until),     // prices
      loop(processBudget(prefix, opts), 20, PRIORITIES.FUNDAMENTALS, until), // earnings/dividends
      loop(processBudget(prefix, opts), 10, PRIORITIES.INTERACTIVE, until),  // import profiles
    ]);

    // Client-side timestamps trail the Redis grant time by a few ms; check
    // every window a little shorter than the real one to absorb that jitter.
    const slack = 50;
    grants.sort((a, b) => a.at - b.at);
    let maxInWindow = 0;
    for (let i = 0; i < grants.length; i++) {
      let sum = 0;
      for (let j = i; j < grants.length && grants[j].at < grants[i].at + WINDOW - slack; j++) sum += grants[j].credits;
      maxInWindow = Math.max(maxInWindow, sum);
    }
    expect(grants.length).toBeGreaterThan(10);
    expect(maxInWindow).toBeLessThanOrEqual(LIMIT);
  }, 15_000);

  it('two processes share one budget', async () => {
    const opts = { limit: 50, windowMs: 2000, pollCapMs: 50 };
    const web = processBudget(prefix, opts);
    const worker = processBudget(prefix, opts);
    let granted = 0;

    const fire = (budget) => Array.from({ length: 40 }, () =>
      budget.acquire({ endpoint: 'quote', credits: 1, priority: PRIORITIES.VALUATION }).then(() => { granted += 1; }));
    const all = Promise.all([...fire(web), ...fire(worker)]);

    await sleep(500);
    expect(granted).toBe(50);
    const members = await reader.zrange(`${prefix}:log`, 0, -1);
    expect(members).toHaveLength(50);

    await all; // the other 30 go through once the window slides
    expect(granted).toBe(80);
  }, 15_000);

  it('serves waiting callers by priority: interactive, valuation, fundamentals, background', async () => {
    const opts = { limit: 4, windowMs: 600, pollCapMs: 40 };
    const filler = processBudget(prefix, opts);
    await filler.acquire({ endpoint: 'profile', credits: 4, priority: PRIORITIES.VALUATION });

    const order = [];
    const start = (priority) => processBudget(prefix, opts)
      .acquire({ endpoint: 'profile', credits: 4, priority })
      .then(() => order.push(priority));

    // Lowest priority registers first, so order of arrival can't explain the result.
    const pending = [];
    for (const p of [PRIORITIES.BACKGROUND, PRIORITIES.FUNDAMENTALS, PRIORITIES.VALUATION, PRIORITIES.INTERACTIVE]) {
      pending.push(start(p));
      await sleep(40);
    }
    await Promise.all(pending);

    expect(order).toEqual([
      PRIORITIES.INTERACTIVE,
      PRIORITIES.VALUATION,
      PRIORITIES.FUNDAMENTALS,
      PRIORITIES.BACKGROUND,
    ]);
  }, 15_000);

  it('a crashed higher-priority waiter stops blocking after the waiter TTL', async () => {
    const opts = { limit: 10, windowMs: 60_000, pollCapMs: 40, waiterTtlMs: 300 };
    // A waiter that heartbeated once and died.
    await reader.zadd(`${prefix}:waiters`, Date.now(), `${PRIORITIES.INTERACTIVE}:dead`);

    const t0 = Date.now();
    const r = await processBudget(prefix, opts)
      .acquire({ endpoint: 'quote', credits: 1, priority: PRIORITIES.BACKGROUND });

    expect(r.mode).toBe('shared');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
    expect(Date.now() - t0).toBeLessThan(2000);
  }, 10_000);

  it('a 429 pause holds every process until it lapses', async () => {
    const opts = { limit: 100, windowMs: 60_000, pollCapMs: 40 };
    processBudget(prefix, opts).pause(400);
    await sleep(20); // the pause write is fire-and-forget

    const r = await processBudget(prefix, opts)
      .acquire({ endpoint: 'quote', credits: 1, priority: PRIORITIES.INTERACTIVE });

    expect(r.waitedMs).toBeGreaterThanOrEqual(300);
  }, 10_000);

  it('a starved low-priority caller still completes once higher work stops', async () => {
    const opts = { limit: 5, windowMs: 300, pollCapMs: 30 };
    const busy = processBudget(prefix, opts);
    const until = Date.now() + 1500; // five compressed windows of interactive load
    const load = (async () => {
      while (Date.now() < until) await busy.acquire({ endpoint: 'quote', credits: 1, priority: PRIORITIES.INTERACTIVE });
    })();
    await sleep(20);

    const r = await processBudget(prefix, opts)
      .acquire({ endpoint: 'earnings', credits: 5, priority: PRIORITIES.FUNDAMENTALS });
    await load;

    expect(r.mode).toBe('shared');
    expect(r.waitedMs).toBeGreaterThanOrEqual(1000);
  }, 15_000);
});
