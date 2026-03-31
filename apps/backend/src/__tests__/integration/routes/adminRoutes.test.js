/**
 * Integration tests for POST /api/admin/regenerate-embedding
 *
 * Tests the full Express route stack: CORS middleware -> apiKeyAuth -> route handler.
 * Both geminiService and categorizationService are mocked so tests focus on the
 * HTTP contract without requiring live Gemini API or database connections.
 *
 * No database setup required for this test file.
 */

const request = require('supertest');

// Mock dependencies before requiring app
jest.mock('../../../services/geminiService', () => ({
  generateEmbedding: jest.fn(),
  classifyTransaction: jest.fn(),
}));

jest.mock('../../../services/categorizationService', () => ({
  classify: jest.fn(),
  recordFeedback: jest.fn(),
  upsertGlobalEmbedding: jest.fn(),
}));

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const app = require('../../../app');
const geminiService = require('../../../services/geminiService');
const { upsertGlobalEmbedding } = require('../../../services/categorizationService');

const API_KEY = process.env.INTERNAL_API_KEY;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_EMBEDDING = new Array(768).fill(0.1);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/admin/regenerate-embedding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    geminiService.generateEmbedding.mockResolvedValue(MOCK_EMBEDDING);
    upsertGlobalEmbedding.mockResolvedValue(undefined);
  });

  it('returns 401 without API key', async () => {
    const res = await request(app)
      .post('/api/admin/regenerate-embedding')
      .send({ description: 'Starbucks', defaultCategoryCode: 'FOOD_AND_DINING' });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 400 when description is missing', async () => {
    const res = await request(app)
      .post('/api/admin/regenerate-embedding')
      .set('X-API-KEY', API_KEY)
      .send({ defaultCategoryCode: 'FOOD_AND_DINING' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/description/i);
  });

  it('returns 400 when description is an empty string', async () => {
    const res = await request(app)
      .post('/api/admin/regenerate-embedding')
      .set('X-API-KEY', API_KEY)
      .send({ description: '   ', defaultCategoryCode: 'FOOD_AND_DINING' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/description/i);
  });

  it('returns 400 when defaultCategoryCode is missing', async () => {
    const res = await request(app)
      .post('/api/admin/regenerate-embedding')
      .set('X-API-KEY', API_KEY)
      .send({ description: 'Starbucks' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/defaultCategoryCode/i);
  });

  it('returns 200 on success and calls both services with trimmed description', async () => {
    const res = await request(app)
      .post('/api/admin/regenerate-embedding')
      .set('X-API-KEY', API_KEY)
      .send({ description: '  Starbucks Coffee  ', defaultCategoryCode: 'FOOD_AND_DINING' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // Verify geminiService was called with trimmed description
    expect(geminiService.generateEmbedding).toHaveBeenCalledWith('Starbucks Coffee');

    // Verify upsertGlobalEmbedding was called with trimmed description, code, and embedding
    expect(upsertGlobalEmbedding).toHaveBeenCalledWith(
      'Starbucks Coffee',
      'FOOD_AND_DINING',
      MOCK_EMBEDDING
    );
  });

  it('returns 500 when embedding generation fails', async () => {
    geminiService.generateEmbedding.mockRejectedValue(new Error('Gemini API error'));

    const res = await request(app)
      .post('/api/admin/regenerate-embedding')
      .set('X-API-KEY', API_KEY)
      .send({ description: 'Starbucks', defaultCategoryCode: 'FOOD_AND_DINING' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to regenerate embedding/i);
    expect(upsertGlobalEmbedding).not.toHaveBeenCalled();
  });
});
