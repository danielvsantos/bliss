/**
 * Integration tests for /api/insights routes (v1 — tiered architecture).
 *
 * Tests the full Express route stack: CORS middleware -> apiKeyAuth -> route handler.
 * The insightQueue and insightRetentionService are mocked so tests focus on the
 * HTTP contract without requiring a live Redis / Prisma connection.
 *
 * Routes covered:
 *   - POST /api/insights/generate
 *       * Legacy path (tenantId only → defaults to DAILY tier)
 *       * Tiered path (MONTHLY / QUARTERLY / ANNUAL / PORTFOLIO)
 *       * Tier validation (invalid, missing required params)
 *   - POST /api/insights/cleanup
 *       * Auth check
 *       * Happy path (returns deletedCount)
 *       * Error path
 */

const request = require('supertest');

// Mock the insight queue — prevents Redis connection in tests
jest.mock('../../../queues/insightQueue', () => ({
  enqueueInsightJob: jest.fn().mockResolvedValue({ id: 'mock-insight-job-id' }),
}));

// Mock retention service — prevents hitting Prisma
jest.mock('../../../services/insightRetentionService', () => ({
  cleanupExpiredInsights: jest.fn().mockResolvedValue(42),
}));

const app = require('../../../app');
const { enqueueInsightJob } = require('../../../queues/insightQueue');
const { cleanupExpiredInsights } = require('../../../services/insightRetentionService');

const API_KEY = process.env.INTERNAL_API_KEY;

describe('/api/insights routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Re-establish default resolution since clearAllMocks wipes implementations
    enqueueInsightJob.mockResolvedValue({ id: 'mock-insight-job-id' });
    cleanupExpiredInsights.mockResolvedValue(42);
  });

  // ─── Auth ──────────────────────────────────────────────────────────────────

  describe('authentication', () => {
    it('POST /generate returns 401 without X-API-KEY header', async () => {
      const res = await request(app)
        .post('/api/insights/generate')
        .send({ tenantId: 'tenant-1' });

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: 'Unauthorized' });
    });

    it('POST /generate returns 401 with incorrect API key', async () => {
      const res = await request(app)
        .post('/api/insights/generate')
        .set('X-API-KEY', 'wrong-key')
        .send({ tenantId: 'tenant-1' });

      expect(res.status).toBe(401);
    });

    it('POST /cleanup returns 401 without X-API-KEY header', async () => {
      const res = await request(app).post('/api/insights/cleanup').send({});
      expect(res.status).toBe(401);
    });

    it('POST /cleanup returns 401 with incorrect API key', async () => {
      const res = await request(app)
        .post('/api/insights/cleanup')
        .set('X-API-KEY', 'wrong-key')
        .send({});
      expect(res.status).toBe(401);
    });
  });

  // ─── POST /generate ───────────────────────────────────────────────────────

  describe('POST /api/insights/generate', () => {
    it('returns 400 without tenantId in body', async () => {
      const res = await request(app)
        .post('/api/insights/generate')
        .set('X-API-KEY', API_KEY)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/tenantId/i);
      expect(enqueueInsightJob).not.toHaveBeenCalled();
    });

    it('legacy path: enqueues with tenantId only and defaults to DAILY', async () => {
      const res = await request(app)
        .post('/api/insights/generate')
        .set('X-API-KEY', API_KEY)
        .send({ tenantId: 'tenant-abc' });

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({
        message: 'Insight generation job enqueued',
        tier: 'DAILY',
      });
      expect(enqueueInsightJob).toHaveBeenCalledWith(
        'generate-tenant-insights',
        expect.objectContaining({ tenantId: 'tenant-abc' }),
      );
    });

    it('tiered path: MONTHLY with year+month enqueues and returns tier=MONTHLY', async () => {
      const res = await request(app)
        .post('/api/insights/generate')
        .set('X-API-KEY', API_KEY)
        .send({ tenantId: 'tenant-abc', tier: 'MONTHLY', year: 2026, month: 3 });

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({
        message: 'Insight generation job enqueued',
        tier: 'MONTHLY',
      });
      expect(enqueueInsightJob).toHaveBeenCalledWith(
        'generate-tenant-insights',
        expect.objectContaining({
          tenantId: 'tenant-abc',
          tier: 'MONTHLY',
          year: 2026,
          month: 3,
        }),
      );
    });

    it('tiered path: QUARTERLY with year+quarter enqueues and returns tier=QUARTERLY', async () => {
      const res = await request(app)
        .post('/api/insights/generate')
        .set('X-API-KEY', API_KEY)
        .send({ tenantId: 'tenant-abc', tier: 'QUARTERLY', year: 2026, quarter: 1 });

      expect(res.status).toBe(202);
      expect(res.body.tier).toBe('QUARTERLY');
      expect(enqueueInsightJob).toHaveBeenCalledWith(
        'generate-tenant-insights',
        expect.objectContaining({ tier: 'QUARTERLY', year: 2026, quarter: 1 }),
      );
    });

    it('tiered path: ANNUAL with year enqueues and returns tier=ANNUAL', async () => {
      const res = await request(app)
        .post('/api/insights/generate')
        .set('X-API-KEY', API_KEY)
        .send({ tenantId: 'tenant-abc', tier: 'ANNUAL', year: 2025 });

      expect(res.status).toBe(202);
      expect(res.body.tier).toBe('ANNUAL');
      expect(enqueueInsightJob).toHaveBeenCalledWith(
        'generate-tenant-insights',
        expect.objectContaining({ tier: 'ANNUAL', year: 2025 }),
      );
    });

    it('tiered path: PORTFOLIO enqueues without period params', async () => {
      const res = await request(app)
        .post('/api/insights/generate')
        .set('X-API-KEY', API_KEY)
        .send({ tenantId: 'tenant-abc', tier: 'PORTFOLIO' });

      expect(res.status).toBe(202);
      expect(res.body.tier).toBe('PORTFOLIO');
      expect(enqueueInsightJob).toHaveBeenCalledWith(
        'generate-tenant-insights',
        expect.objectContaining({ tier: 'PORTFOLIO' }),
      );
    });

    it('tiered path: passes force=true through to the worker job', async () => {
      const res = await request(app)
        .post('/api/insights/generate')
        .set('X-API-KEY', API_KEY)
        .send({ tenantId: 'tenant-abc', tier: 'DAILY', force: true });

      expect(res.status).toBe(202);
      expect(enqueueInsightJob).toHaveBeenCalledWith(
        'generate-tenant-insights',
        expect.objectContaining({ tier: 'DAILY', force: true }),
      );
    });

    // ── Validation ────────────────────────────────────────────────────────
    it('returns 400 when tier is invalid', async () => {
      const res = await request(app)
        .post('/api/insights/generate')
        .set('X-API-KEY', API_KEY)
        .send({ tenantId: 'tenant-abc', tier: 'WEEKLY' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid tier/i);
      expect(res.body.error).toMatch(/DAILY/);
      expect(res.body.error).toMatch(/MONTHLY/);
      expect(res.body.error).toMatch(/QUARTERLY/);
      expect(res.body.error).toMatch(/ANNUAL/);
      expect(res.body.error).toMatch(/PORTFOLIO/);
      expect(enqueueInsightJob).not.toHaveBeenCalled();
    });

    it('returns 400 when MONTHLY tier is missing year', async () => {
      const res = await request(app)
        .post('/api/insights/generate')
        .set('X-API-KEY', API_KEY)
        .send({ tenantId: 'tenant-abc', tier: 'MONTHLY', month: 3 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/year and month are required/i);
      expect(enqueueInsightJob).not.toHaveBeenCalled();
    });

    it('returns 400 when MONTHLY tier is missing month', async () => {
      const res = await request(app)
        .post('/api/insights/generate')
        .set('X-API-KEY', API_KEY)
        .send({ tenantId: 'tenant-abc', tier: 'MONTHLY', year: 2026 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/year and month are required/i);
      expect(enqueueInsightJob).not.toHaveBeenCalled();
    });

    it('returns 400 when QUARTERLY tier is missing year or quarter', async () => {
      const missingYear = await request(app)
        .post('/api/insights/generate')
        .set('X-API-KEY', API_KEY)
        .send({ tenantId: 'tenant-abc', tier: 'QUARTERLY', quarter: 1 });
      expect(missingYear.status).toBe(400);
      expect(missingYear.body.error).toMatch(/year and quarter are required/i);

      const missingQuarter = await request(app)
        .post('/api/insights/generate')
        .set('X-API-KEY', API_KEY)
        .send({ tenantId: 'tenant-abc', tier: 'QUARTERLY', year: 2026 });
      expect(missingQuarter.status).toBe(400);
      expect(missingQuarter.body.error).toMatch(/year and quarter are required/i);

      expect(enqueueInsightJob).not.toHaveBeenCalled();
    });

    it('returns 400 when ANNUAL tier is missing year', async () => {
      const res = await request(app)
        .post('/api/insights/generate')
        .set('X-API-KEY', API_KEY)
        .send({ tenantId: 'tenant-abc', tier: 'ANNUAL' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/year is required/i);
      expect(enqueueInsightJob).not.toHaveBeenCalled();
    });

    it('returns 500 when queue enqueue fails', async () => {
      enqueueInsightJob.mockRejectedValue(new Error('Redis down'));

      const res = await request(app)
        .post('/api/insights/generate')
        .set('X-API-KEY', API_KEY)
        .send({ tenantId: 'tenant-abc' });

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/Failed to enqueue/i);
    });
  });

  // ─── POST /cleanup ────────────────────────────────────────────────────────

  describe('POST /api/insights/cleanup', () => {
    it('returns 200 with deletedCount on success', async () => {
      cleanupExpiredInsights.mockResolvedValue(17);

      const res = await request(app)
        .post('/api/insights/cleanup')
        .set('X-API-KEY', API_KEY)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deletedCount: 17 });
      expect(cleanupExpiredInsights).toHaveBeenCalledTimes(1);
    });

    it('returns 500 when cleanup service throws', async () => {
      cleanupExpiredInsights.mockRejectedValue(new Error('Prisma down'));

      const res = await request(app)
        .post('/api/insights/cleanup')
        .set('X-API-KEY', API_KEY)
        .send({});

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/Failed to cleanup/i);
    });
  });
});
