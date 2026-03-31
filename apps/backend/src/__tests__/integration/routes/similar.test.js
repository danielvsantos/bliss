/**
 * Integration tests for GET /api/similar
 *
 * Tests the full Express route stack: CORS middleware -> apiKeyAuth -> route handler.
 * The geminiService and Prisma client are mocked so tests focus on the HTTP contract
 * without requiring live Redis, Gemini API, or pgvector connections.
 *
 * No database setup required for this test file.
 */

const request = require('supertest');

// Mock dependencies before requiring app
jest.mock('../../../services/geminiService', () => ({
  generateEmbedding: jest.fn(),
  classifyTransaction: jest.fn(),
}));

jest.mock('../../../../prisma/prisma', () => ({
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
}));

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const app = require('../../../app');
const geminiService = require('../../../services/geminiService');
const prisma = require('../../../../prisma/prisma');

const API_KEY = process.env.INTERNAL_API_KEY;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_EMBEDDING = new Array(768).fill(0.1);

const MOCK_QUERY_RESULTS = [
  {
    id: 1,
    transactionId: 100,
    categoryId: 5,
    source: 'USER_OVERRIDE',
    similarity: 0.92,
  },
  {
    id: 2,
    transactionId: null,
    categoryId: 3,
    source: 'VECTOR_MATCH',
    similarity: 0.85,
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/similar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    geminiService.generateEmbedding.mockResolvedValue(MOCK_EMBEDDING);
    prisma.$queryRaw.mockResolvedValue(MOCK_QUERY_RESULTS);
  });

  it('returns 401 when X-API-KEY header is missing', async () => {
    const res = await request(app)
      .get('/api/similar')
      .query({ description: 'Coffee', tenantId: 'tenant-1' });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 401 when X-API-KEY is incorrect', async () => {
    const res = await request(app)
      .get('/api/similar')
      .set('X-API-KEY', 'bad-key')
      .query({ description: 'Coffee', tenantId: 'tenant-1' });

    expect(res.status).toBe(401);
  });

  it('returns 400 when description is missing', async () => {
    const res = await request(app)
      .get('/api/similar')
      .set('X-API-KEY', API_KEY)
      .query({ tenantId: 'tenant-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/description/i);
  });

  it('returns 400 when tenantId is missing', async () => {
    const res = await request(app)
      .get('/api/similar')
      .set('X-API-KEY', API_KEY)
      .query({ description: 'Coffee' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tenantId/i);
  });

  it('returns 200 with formatted results array', async () => {
    const res = await request(app)
      .get('/api/similar')
      .set('X-API-KEY', API_KEY)
      .query({ description: 'Coffee Shop', tenantId: 'tenant-1' });

    expect(res.status).toBe(200);
    expect(geminiService.generateEmbedding).toHaveBeenCalledWith('Coffee Shop');
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toEqual({
      id: 1,
      transactionId: 100,
      categoryId: 5,
      source: 'USER_OVERRIDE',
      similarity: 0.92,
    });
    expect(res.body[1]).toEqual({
      id: 2,
      transactionId: null,
      categoryId: 3,
      source: 'VECTOR_MATCH',
      similarity: 0.85,
    });
  });

  it('caps limit at 20 when a higher value is passed', async () => {
    const res = await request(app)
      .get('/api/similar')
      .set('X-API-KEY', API_KEY)
      .query({ description: 'Coffee', tenantId: 'tenant-1', limit: 50 });

    expect(res.status).toBe(200);

    // The route calls prisma.$queryRaw with a tagged template literal.
    // Verify it was called and that the maxResults was capped at 20.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const rawCall = prisma.$queryRaw.mock.calls[0];
    // Tagged template: the values array contains the interpolated params.
    // The last interpolated value is maxResults (LIMIT $N).
    const interpolatedValues = rawCall.slice(1);
    const limitValue = interpolatedValues[interpolatedValues.length - 1];
    expect(limitValue).toBe(20);
  });

  it('returns 500 when embedding generation fails', async () => {
    geminiService.generateEmbedding.mockRejectedValue(new Error('Gemini API error'));

    const res = await request(app)
      .get('/api/similar')
      .set('X-API-KEY', API_KEY)
      .query({ description: 'Coffee', tenantId: 'tenant-1' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/similarity search/i);
  });
});
