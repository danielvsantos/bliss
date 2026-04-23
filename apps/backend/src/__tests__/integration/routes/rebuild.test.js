/**
 * Integration tests for the admin Maintenance routes:
 *
 *   POST /api/admin/rebuild/trigger
 *   GET  /api/admin/rebuild/status
 *
 * Tests the full Express stack: helmet → cors → apiKeyAuth → route handler.
 * The single-flight lock, events queue, and the portfolio/analytics queues
 * are all mocked at the module boundary so these tests focus on HTTP
 * contract + routing shape without requiring Redis or BullMQ.
 */

jest.mock('../../../queues/eventsQueue', () => ({
  enqueueEvent: jest.fn().mockResolvedValue({ id: 'mock-event-id' }),
  EVENTS_QUEUE_NAME: 'mock-events',
  getEventsQueue: jest.fn(),
}));

jest.mock('../../../utils/singleFlightLock', () => ({
  acquire: jest.fn(),
  release: jest.fn(),
  isHeld: jest.fn(),
}));

// Each queue exposes `getJobs` so the status endpoint can aggregate them.
// We return the BullMQ-shaped objects directly; `getState` is per-job.
const mockGetJobsPortfolio = jest.fn();
const mockGetJobsAnalytics = jest.fn();

jest.mock('../../../queues/portfolioQueue', () => ({
  PORTFOLIO_QUEUE_NAME: 'mock-portfolio',
  getPortfolioQueue: jest.fn(() => ({ getJobs: mockGetJobsPortfolio })),
}));

jest.mock('../../../queues/analyticsQueue', () => ({
  ANALYTICS_QUEUE_NAME: 'mock-analytics',
  getAnalyticsQueue: jest.fn(() => ({ getJobs: mockGetJobsAnalytics })),
}));

// Mock Prisma: status endpoint now also reads portfolioItem for the
// single-asset picker. We don't want a real DB, so mock the one call
// and have each test override what it returns.
const mockPortfolioItemFindMany = jest.fn();
jest.mock('../../../../prisma/prisma.js', () => ({
  portfolioItem: { findMany: (...args) => mockPortfolioItemFindMany(...args) },
}));

const request = require('supertest');
const app = require('../../../app');
const { enqueueEvent } = require('../../../queues/eventsQueue');
const { acquire, isHeld } = require('../../../utils/singleFlightLock');

const API_KEY = process.env.INTERNAL_API_KEY;
const TENANT = 'tenant-rebuild-test';

// Helper: fabricate a BullMQ-shaped job with the fields the route reads.
// Note: the route no longer calls `job.getState()` — state is derived
// from which list it came from in the per-state `getJobs` split. The
// `state` parameter here only drives how the test routes the job into
// the mock bucket via `stubQueueJobs`.
function makeJob({
  id, name, tenantId = TENANT, rebuildType = 'full-analytics',
  progress = 100,
  requestedBy = 'admin@example.com',
  requestedAt = '2026-04-23T10:00:00.000Z',
  finishedAt = '2026-04-23T10:05:00.000Z',
  processedAt = null,
  failedReason = null,
  attemptsMade = 1,
}) {
  return {
    id,
    name,
    data: {
      tenantId,
      _rebuildMeta: { rebuildType, requestedBy, requestedAt },
    },
    progress,
    finishedOn: finishedAt ? Date.parse(finishedAt) : null,
    processedOn: processedAt ? Date.parse(processedAt) : null,
    failedReason,
    attemptsMade,
  };
}

// Wire a `mockGetJobs*` mock so each per-state `getJobs([state], 0, N)`
// call gets the bucket mapped to that state (defaults to `[]`).
function stubQueueJobs(queueMock, byState = {}) {
  queueMock.mockImplementation((states) => {
    const state = Array.isArray(states) ? states[0] : states;
    return Promise.resolve(byState[state] || []);
  });
}

describe('POST /api/admin/rebuild/trigger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    acquire.mockResolvedValue(true);
    isHeld.mockResolvedValue({ held: false, ttlSeconds: null });
  });

  it('returns 401 when X-API-KEY header is missing', async () => {
    const res = await request(app)
      .post('/api/admin/rebuild/trigger')
      .send({ tenantId: TENANT, scope: 'full-analytics' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when tenantId is missing', async () => {
    const res = await request(app)
      .post('/api/admin/rebuild/trigger')
      .set('X-API-KEY', API_KEY)
      .send({ scope: 'full-analytics' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tenantId/);
  });

  it('returns 400 when scope is invalid', async () => {
    const res = await request(app)
      .post('/api/admin/rebuild/trigger')
      .set('X-API-KEY', API_KEY)
      .send({ tenantId: TENANT, scope: 'not-a-real-scope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scope must be one of/);
  });

  it('returns 400 when scoped-analytics payload is missing earliestDate', async () => {
    const res = await request(app)
      .post('/api/admin/rebuild/trigger')
      .set('X-API-KEY', API_KEY)
      .send({ tenantId: TENANT, scope: 'scoped-analytics' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/earliestDate/);
  });

  it('returns 400 when scoped-analytics earliestDate is invalid', async () => {
    const res = await request(app)
      .post('/api/admin/rebuild/trigger')
      .set('X-API-KEY', API_KEY)
      .send({
        tenantId: TENANT,
        scope: 'scoped-analytics',
        payload: { earliestDate: 'not-a-date' },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/earliestDate/);
  });

  it('returns 400 when single-asset payload is missing portfolioItemId', async () => {
    const res = await request(app)
      .post('/api/admin/rebuild/trigger')
      .set('X-API-KEY', API_KEY)
      .send({ tenantId: TENANT, scope: 'single-asset' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/portfolioItemId/);
  });

  it('returns 202 and enqueues MANUAL_REBUILD_REQUESTED on valid full-analytics', async () => {
    const res = await request(app)
      .post('/api/admin/rebuild/trigger')
      .set('X-API-KEY', API_KEY)
      .send({ tenantId: TENANT, scope: 'full-analytics', requestedBy: 'alice@example.com' });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: 'accepted',
      scope: 'full-analytics',
      lockTtlSeconds: 3600,
    });
    expect(res.body.requestedAt).toEqual(expect.any(String));

    // Lock acquired before enqueue.
    expect(acquire).toHaveBeenCalledWith(
      `rebuild-lock:${TENANT}:full-analytics`,
      3600,
    );
    expect(enqueueEvent).toHaveBeenCalledWith('MANUAL_REBUILD_REQUESTED', {
      tenantId: TENANT,
      scope: 'full-analytics',
      requestedBy: 'alice@example.com',
      requestedAt: expect.any(String),
      payload: null,
      source: 'admin-maintenance-ui',
    });
  });

  it('returns 409 with remaining TTL when the lock is already held', async () => {
    acquire.mockResolvedValueOnce(false);
    isHeld.mockResolvedValueOnce({ held: true, ttlSeconds: 1234 });

    const res = await request(app)
      .post('/api/admin/rebuild/trigger')
      .set('X-API-KEY', API_KEY)
      .send({ tenantId: TENANT, scope: 'full-portfolio' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'Rebuild already in progress',
      scope: 'full-portfolio',
      ttlSeconds: 1234,
    });
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it('forwards scoped-analytics payload through to the event', async () => {
    const res = await request(app)
      .post('/api/admin/rebuild/trigger')
      .set('X-API-KEY', API_KEY)
      .send({
        tenantId: TENANT,
        scope: 'scoped-analytics',
        payload: { earliestDate: '2026-03-01T00:00:00.000Z' },
      });

    expect(res.status).toBe(202);
    expect(enqueueEvent).toHaveBeenCalledWith('MANUAL_REBUILD_REQUESTED', expect.objectContaining({
      scope: 'scoped-analytics',
      payload: { earliestDate: '2026-03-01T00:00:00.000Z' },
    }));
  });

  it('forwards single-asset payload through to the event', async () => {
    const res = await request(app)
      .post('/api/admin/rebuild/trigger')
      .set('X-API-KEY', API_KEY)
      .send({
        tenantId: TENANT,
        scope: 'single-asset',
        payload: { portfolioItemId: 42 },
      });

    expect(res.status).toBe(202);
    expect(enqueueEvent).toHaveBeenCalledWith('MANUAL_REBUILD_REQUESTED', expect.objectContaining({
      scope: 'single-asset',
      payload: { portfolioItemId: 42 },
    }));
  });
});

describe('GET /api/admin/rebuild/status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no locks held, no jobs in any state, no assets.
    isHeld.mockResolvedValue({ held: false, ttlSeconds: null });
    stubQueueJobs(mockGetJobsPortfolio);
    stubQueueJobs(mockGetJobsAnalytics);
    mockPortfolioItemFindMany.mockResolvedValue([]);
  });

  it('returns 401 when X-API-KEY header is missing', async () => {
    const res = await request(app).get(`/api/admin/rebuild/status?tenantId=${TENANT}`);
    expect(res.status).toBe(401);
  });

  it('returns 400 when tenantId query param is missing', async () => {
    const res = await request(app)
      .get('/api/admin/rebuild/status')
      .set('X-API-KEY', API_KEY);
    expect(res.status).toBe(400);
  });

  it('returns empty locks + current + recent + assets when nothing is happening', async () => {
    const res = await request(app)
      .get(`/api/admin/rebuild/status?tenantId=${TENANT}`)
      .set('X-API-KEY', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.locks).toEqual(expect.arrayContaining([
      { scope: 'full-portfolio', held: false, ttlSeconds: null },
      { scope: 'full-analytics', held: false, ttlSeconds: null },
      { scope: 'scoped-analytics', held: false, ttlSeconds: null },
      { scope: 'single-asset', held: false, ttlSeconds: null },
    ]));
    expect(res.body.current).toEqual([]);
    expect(res.body.recent).toEqual([]);
    expect(res.body.assets).toEqual([]);
  });

  it('returns the single-asset picker list scoped to the tenant (no price fetch)', async () => {
    mockPortfolioItemFindMany.mockResolvedValueOnce([
      { id: 1, symbol: 'AAPL', currency: 'USD', category: { name: 'Stocks' } },
      { id: 2, symbol: 'BTC',  currency: 'USD', category: { name: 'Crypto' } },
    ]);

    const res = await request(app)
      .get(`/api/admin/rebuild/status?tenantId=${TENANT}`)
      .set('X-API-KEY', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.assets).toEqual([
      { id: 1, symbol: 'AAPL', currency: 'USD', category: { name: 'Stocks' } },
      { id: 2, symbol: 'BTC',  currency: 'USD', category: { name: 'Crypto' } },
    ]);

    // Perf guarantee: the portfolioItem query is scoped by tenantId +
    // asset-like categories, selects ONLY the picker fields, and does
    // NOT pull `currentValue`, `manualValues`, or anything that would
    // push the caller into a live-price path.
    expect(mockPortfolioItemFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT,
          category: { type: { in: ['Investments', 'Asset', 'Debt'] } },
        }),
        select: {
          id: true,
          symbol: true,
          currency: true,
          category: { select: { name: true } },
        },
      }),
    );
  });

  it('separates active jobs into `current` and completed/failed into `recent`', async () => {
    const activeJob = makeJob({ id: 1, name: 'full-rebuild-analytics', progress: 42, processedAt: '2026-04-23T10:00:00.000Z', finishedAt: null });
    const completedJob = makeJob({ id: 2, name: 'value-all-assets', rebuildType: 'full-portfolio', finishedAt: '2026-04-22T10:00:00.000Z' });
    const failedJob = makeJob({ id: 3, name: 'full-rebuild-analytics', failedReason: 'Prisma timeout', finishedAt: '2026-04-21T10:00:00.000Z' });

    stubQueueJobs(mockGetJobsAnalytics, { active: [activeJob], failed: [failedJob] });
    stubQueueJobs(mockGetJobsPortfolio, { completed: [completedJob] });

    const res = await request(app)
      .get(`/api/admin/rebuild/status?tenantId=${TENANT}`)
      .set('X-API-KEY', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.current).toHaveLength(1);
    expect(res.body.current[0]).toMatchObject({ id: 1, state: 'active', progress: 42 });
    expect(res.body.recent).toHaveLength(2);
    // Newest first.
    expect(res.body.recent[0]).toMatchObject({ id: 2, state: 'completed' });
    expect(res.body.recent[1]).toMatchObject({ id: 3, state: 'failed', failedReason: 'Prisma timeout' });
  });

  it('filters out jobs without _rebuildMeta (nightly crons, etc.)', async () => {
    const adminJob = makeJob({ id: 1, name: 'full-rebuild-analytics' });
    const cronJob = {
      id: 99,
      name: 'revalue-all-tenants',
      // No _rebuildMeta — a nightly cron run.
      data: { tenantId: TENANT },
      progress: 100,
      finishedOn: Date.now(),
      processedOn: Date.now() - 60_000,
      failedReason: null,
      attemptsMade: 1,
    };
    stubQueueJobs(mockGetJobsAnalytics, { completed: [adminJob] });
    stubQueueJobs(mockGetJobsPortfolio, { completed: [cronJob] });

    const res = await request(app)
      .get(`/api/admin/rebuild/status?tenantId=${TENANT}`)
      .set('X-API-KEY', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.recent).toHaveLength(1);
    expect(res.body.recent[0].id).toBe(1);
  });

  it('filters out jobs for other tenants', async () => {
    const mine = makeJob({ id: 1, name: 'full-rebuild-analytics', tenantId: TENANT });
    const theirs = makeJob({ id: 2, name: 'full-rebuild-analytics', tenantId: 'other-tenant' });
    stubQueueJobs(mockGetJobsAnalytics, { completed: [mine, theirs] });

    const res = await request(app)
      .get(`/api/admin/rebuild/status?tenantId=${TENANT}`)
      .set('X-API-KEY', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.recent).toHaveLength(1);
    expect(res.body.recent[0].id).toBe(1);
  });

  it('surfaces lock TTLs so the UI can show "next available in X min"', async () => {
    isHeld.mockImplementation(async (key) => {
      if (key.endsWith('full-portfolio')) return { held: true, ttlSeconds: 1800 };
      return { held: false, ttlSeconds: null };
    });

    const res = await request(app)
      .get(`/api/admin/rebuild/status?tenantId=${TENANT}`)
      .set('X-API-KEY', API_KEY);

    expect(res.status).toBe(200);
    const portfolio = res.body.locks.find((l) => l.scope === 'full-portfolio');
    expect(portfolio).toEqual({ scope: 'full-portfolio', held: true, ttlSeconds: 1800 });
  });

  it('caps the recent list to 20 entries', async () => {
    const jobs = Array.from({ length: 30 }, (_, i) =>
      makeJob({
        id: i + 1,
        name: 'full-rebuild-analytics',
        finishedAt: new Date(Date.now() - i * 60_000).toISOString(),
      }),
    );
    stubQueueJobs(mockGetJobsAnalytics, { completed: jobs });

    const res = await request(app)
      .get(`/api/admin/rebuild/status?tenantId=${TENANT}`)
      .set('X-API-KEY', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.recent).toHaveLength(20);
  });

  // Chain-visibility guard: a full-portfolio rebuild is 4 BullMQ subjobs
  // (process-portfolio-changes → cash → analytics → value-all-assets)
  // sharing the same `_rebuildMeta.requestedAt`. By deliberate design
  // the endpoint returns ALL of them — the frontend renders a
  // human-readable per-step label so each row is distinguishable and
  // mid-chain failures are precisely located. An earlier attempt at
  // collapsing by requestedAt was reverted after UX review: we'd rather
  // show the admin the real chain progressing than synthesize a
  // single-row summary.

  it('returns every subjob of a full-portfolio chain as its own history entry', async () => {
    const requestedAt = '2026-04-23T10:00:00.000Z';
    const step1 = makeJob({
      id: 101, name: 'process-portfolio-changes', rebuildType: 'full-portfolio',
      requestedAt, finishedAt: '2026-04-23T10:00:30.000Z',
    });
    const step2 = makeJob({
      id: 102, name: 'process-cash-holdings', rebuildType: 'full-portfolio',
      requestedAt, finishedAt: '2026-04-23T10:01:00.000Z',
    });
    const step3 = makeJob({
      id: 103, name: 'full-rebuild-analytics', rebuildType: 'full-portfolio',
      requestedAt, finishedAt: '2026-04-23T10:02:00.000Z',
    });
    const step4 = makeJob({
      id: 104, name: 'value-all-assets', rebuildType: 'full-portfolio',
      requestedAt, finishedAt: '2026-04-23T10:05:00.000Z',
    });
    stubQueueJobs(mockGetJobsPortfolio, { completed: [step1, step2, step4] });
    stubQueueJobs(mockGetJobsAnalytics, { completed: [step3] });

    const res = await request(app)
      .get(`/api/admin/rebuild/status?tenantId=${TENANT}`)
      .set('X-API-KEY', API_KEY);

    expect(res.status).toBe(200);
    // All 4 subjobs present — the frontend disambiguates via
    // `job.name` + a human-readable step label, not by collapsing.
    expect(res.body.recent).toHaveLength(4);
    const names = res.body.recent.map((j) => j.name).sort();
    expect(names).toEqual([
      'full-rebuild-analytics',
      'process-cash-holdings',
      'process-portfolio-changes',
      'value-all-assets',
    ]);
    // All tagged with the same scope so the frontend can still group
    // visually if it wants to.
    expect(res.body.recent.every((j) => j.rebuildType === 'full-portfolio')).toBe(true);
    // And all share the same requestedAt — they came from one click.
    expect(res.body.recent.every((j) => j.requestedAt === requestedAt)).toBe(true);
  });

  // Perf-regression guard: the old implementation called
  // `queue.getJobs(allStates, 0, 200)` then per-job `getState()` to
  // resolve the state bucket. Under contention from an active rebuild
  // that caused the endpoint to time out at 10s regularly. The fix
  // splits into per-state queries (state comes from the list we asked
  // for) so there is NO follow-up `getState()` round-trip.
  it('does not call getState() on individual jobs (state is derived from the bucket)', async () => {
    const getStateSpy = jest.fn().mockResolvedValue('completed');
    const job = makeJob({ id: 1, name: 'full-rebuild-analytics' });
    // Attach a getState spy — if the route starts calling it again, we
    // want the test to fail and flag the regression.
    job.getState = getStateSpy;
    stubQueueJobs(mockGetJobsAnalytics, { completed: [job] });

    const res = await request(app)
      .get(`/api/admin/rebuild/status?tenantId=${TENANT}`)
      .set('X-API-KEY', API_KEY);

    expect(res.status).toBe(200);
    expect(getStateSpy).not.toHaveBeenCalled();
  });
});
