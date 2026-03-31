/**
 * Integration tests for POST /api/feedback
 *
 * Tests the full Express route stack: CORS middleware → apiKeyAuth → route handler.
 * The categorizationService is mocked so these tests focus on the HTTP contract,
 * not the classification logic (which has its own unit tests).
 *
 * Requires: bliss_test Postgres database with migrations applied.
 */

const request = require('supertest');

// Mock the categorization service — recordFeedback unit tests live separately
jest.mock('../../../services/categorizationService', () => ({
  recordFeedback: jest.fn().mockResolvedValue(undefined),
  classify: jest.fn(),
}));

const app = require('../../../app');
const { createIsolatedTenant, teardownTenant } = require('../../helpers/tenant');

const API_KEY = process.env.INTERNAL_API_KEY;

describe('POST /api/feedback', () => {
  let tenantId;

  beforeAll(async () => {
    ({ tenantId } = await createIsolatedTenant({ suffix: 'feedback' }));
  });

  afterAll(async () => {
    await teardownTenant(tenantId);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when X-API-KEY header is missing', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .send({ description: 'Coffee', categoryId: 1, tenantId });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 401 when X-API-KEY is wrong', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .set('X-API-KEY', 'wrong-key')
      .send({ description: 'Coffee', categoryId: 1, tenantId });

    expect(res.status).toBe(401);
  });

  it('returns 400 when categoryId is missing', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .set('X-API-KEY', API_KEY)
      .send({ description: 'Coffee', tenantId });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('returns 400 when categoryId is not a positive integer', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .set('X-API-KEY', API_KEY)
      .send({ description: 'Coffee', categoryId: -1, tenantId });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/positive integer/i);
  });

  it('returns 400 when description is missing', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .set('X-API-KEY', API_KEY)
      .send({ categoryId: 1, tenantId });

    expect(res.status).toBe(400);
  });

  it('returns 200 with valid payload and correct API key', async () => {
    const { recordFeedback } = require('../../../services/categorizationService');

    const res = await request(app)
      .post('/api/feedback')
      .set('X-API-KEY', API_KEY)
      .send({ description: 'Morning coffee', categoryId: 5, tenantId });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Feedback recorded' });
    expect(recordFeedback).toHaveBeenCalledWith('Morning coffee', 5, tenantId, null);
  });

  it('passes transactionId to recordFeedback when provided', async () => {
    const { recordFeedback } = require('../../../services/categorizationService');

    const res = await request(app)
      .post('/api/feedback')
      .set('X-API-KEY', API_KEY)
      .send({ description: 'Grocery run', categoryId: 3, tenantId, transactionId: 42 });

    expect(res.status).toBe(200);
    expect(recordFeedback).toHaveBeenCalledWith('Grocery run', 3, tenantId, 42);
  });
});
