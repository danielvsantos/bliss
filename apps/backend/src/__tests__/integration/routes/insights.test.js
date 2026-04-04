/**
 * Integration tests for /api/insights routes
 *
 * Tests the full Express route stack: CORS middleware -> apiKeyAuth -> route handler.
 * The insightQueue is mocked so tests focus on the HTTP contract without
 * requiring a live Redis connection.
 */

const request = require('supertest');

// Mock the insight queue — prevents Redis connection in tests
jest.mock('../../../queues/insightQueue', () => ({
  enqueueInsightJob: jest.fn().mockResolvedValue({ id: 'mock-insight-job-id' }),
}));

const app = require('../../../app');
const { enqueueInsightJob } = require('../../../queues/insightQueue');

const API_KEY = process.env.INTERNAL_API_KEY;

describe('/api/insights routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
    });

    it('returns 202 and enqueues insight generation job', async () => {
      const res = await request(app)
        .post('/api/insights/generate')
        .set('X-API-KEY', API_KEY)
        .send({ tenantId: 'tenant-abc' });

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ message: 'Insight generation job enqueued' });
      expect(enqueueInsightJob).toHaveBeenCalledWith('generate-tenant-insights', {
        tenantId: 'tenant-abc',
      });
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
});
