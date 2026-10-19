jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { EventEmitter } = require('events');
const logger = require('../../../utils/logger');
const { PRIORITIES } = require('../../../config/twelveDataCredits');
const {
  getTwelveDataContext,
  runWithTwelveDataContext,
  withTwelveDataPriority,
  twelveDataRouteContext,
} = require('../../../utils/twelveDataContext');

const usageLogs = () => logger.info.mock.calls.filter(([msg]) => msg === 'twelve_data_usage');

describe('twelveDataContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is undefined outside a context', () => {
    expect(getTwelveDataContext()).toBeUndefined();
  });

  it('propagates the priority across awaits and timers', async () => {
    let seen;
    await runWithTwelveDataContext({ priority: PRIORITIES.FUNDAMENTALS }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      await Promise.resolve();
      seen = getTwelveDataContext().priority;
    });
    expect(seen).toBe(PRIORITIES.FUNDAMENTALS);
    expect(getTwelveDataContext()).toBeUndefined();
  });

  it('keeps the outer context for nested runs so usage is counted once', async () => {
    await runWithTwelveDataContext({ priority: PRIORITIES.VALUATION, label: 'outer' }, async () => {
      await runWithTwelveDataContext({ priority: PRIORITIES.BACKGROUND, label: 'inner' }, async () => {
        expect(getTwelveDataContext().label).toBe('outer');
        getTwelveDataContext().usage.calls += 1;
      });
    });
    expect(usageLogs()).toHaveLength(1);
    expect(usageLogs()[0][1].label).toBe('outer');
  });

  it('logs one twelve_data_usage line per job with summed usage', async () => {
    const processor = jest.fn(async () => {
      const { usage } = getTwelveDataContext();
      for (const credits of [1, 10, 20]) {
        usage.credits += credits;
        usage.calls += 1;
        usage.waitedMs += 100;
      }
      usage.mode = 'shared';
      return 'done';
    });
    const wrapped = withTwelveDataPriority(PRIORITIES.VALUATION, processor);
    const job = { queueName: 'portfolio', name: 'value-all-assets', id: '42', data: { tenantId: 't1' } };

    await expect(wrapped(job, 'token')).resolves.toBe('done');

    expect(processor).toHaveBeenCalledWith(job, 'token');
    expect(usageLogs()).toEqual([[
      'twelve_data_usage',
      {
        label: 'portfolio:value-all-assets',
        queue: 'portfolio',
        jobName: 'value-all-assets',
        jobId: '42',
        tenantId: 't1',
        priority: 'VALUATION',
        credits: 31,
        calls: 3,
        waitedMs: 300,
        rateLimited: 0,
        mode: 'shared',
      },
    ]]);
  });

  it('does not log a job that made no Twelve Data call', async () => {
    await withTwelveDataPriority(PRIORITIES.VALUATION, async () => 'x')({ name: 'n', data: {} });
    expect(usageLogs()).toHaveLength(0);
  });

  it('resolves the priority per job and still logs when the processor throws', async () => {
    const resolver = (job) => (job.name === 'bulk' ? PRIORITIES.BACKGROUND : PRIORITIES.FUNDAMENTALS);
    const wrapped = withTwelveDataPriority(resolver, async () => {
      getTwelveDataContext().usage.calls = 1;
      throw new Error('boom');
    });

    await expect(wrapped({ name: 'bulk', data: {} })).rejects.toThrow('boom');
    expect(usageLogs()[0][1].priority).toBe('BACKGROUND');
  });

  it('route middleware runs the request in a context and logs on finish', () => {
    const res = new EventEmitter();
    res.writableFinished = false;
    let ctx;
    twelveDataRouteContext(PRIORITIES.INTERACTIVE)(
      { method: 'GET', baseUrl: '/api/ticker', path: '/search' },
      res,
      () => {
        ctx = getTwelveDataContext();
        ctx.usage.calls = 1;
        ctx.usage.credits = 1;
      },
    );

    expect(ctx.priority).toBe(PRIORITIES.INTERACTIVE);
    res.writableFinished = true;
    res.emit('finish');
    res.emit('close');
    expect(usageLogs()).toHaveLength(1);
    expect(usageLogs()[0][1]).toMatchObject({ label: 'GET /api/ticker/search', priority: 'INTERACTIVE', credits: 1 });
  });
});
