/**
 * Integration tests for /api/pricing routes
 *
 * Tests the full Express route stack: CORS middleware -> apiKeyAuth -> route handler.
 * The priceService is mocked so tests focus on the HTTP contract without
 * requiring live API connections.
 */

const request = require('supertest');

// Mock the price service — prevents external API calls in tests
jest.mock('../../../services/priceService', () => ({
  getLatestPrice: jest.fn(),
}));

const app = require('../../../app');
const { getLatestPrice } = require('../../../services/priceService');

const API_KEY = process.env.INTERNAL_API_KEY;

describe('/api/pricing routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── Auth ──────────────────────────────────────────────────────────────────

  describe('authentication', () => {
    it('GET /prices returns 401 without X-API-KEY header', async () => {
      const res = await request(app)
        .get('/api/pricing/prices')
        .query({ symbol: 'AAPL', assetType: 'API_STOCK' });

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: 'Unauthorized' });
    });

    it('GET /prices returns 401 with incorrect API key', async () => {
      const res = await request(app)
        .get('/api/pricing/prices')
        .set('X-API-KEY', 'wrong-key')
        .query({ symbol: 'AAPL', assetType: 'API_STOCK' });

      expect(res.status).toBe(401);
    });
  });

  // ─── GET /prices ──────────────────────────────────────────────────────────

  describe('GET /api/pricing/prices', () => {
    it('returns 400 without required query params', async () => {
      const res = await request(app)
        .get('/api/pricing/prices')
        .set('X-API-KEY', API_KEY);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Missing required query parameters/i);
    });

    it('returns 400 when symbol is missing', async () => {
      const res = await request(app)
        .get('/api/pricing/prices')
        .set('X-API-KEY', API_KEY)
        .query({ assetType: 'API_STOCK' });

      expect(res.status).toBe(400);
    });

    it('returns 400 when assetType is missing', async () => {
      const res = await request(app)
        .get('/api/pricing/prices')
        .set('X-API-KEY', API_KEY)
        .query({ symbol: 'AAPL' });

      expect(res.status).toBe(400);
    });

    it('returns 200 with price data for valid params', async () => {
      getLatestPrice.mockResolvedValue({ price: 175.50, source: 'API:TwelveData' });

      const res = await request(app)
        .get('/api/pricing/prices')
        .set('X-API-KEY', API_KEY)
        .query({ symbol: 'AAPL', assetType: 'API_STOCK' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ price: 175.50, source: 'API:TwelveData' });
      expect(getLatestPrice).toHaveBeenCalledWith('AAPL', 'API_STOCK', undefined, { exchange: undefined });
    });

    it('passes currency and exchange to getLatestPrice when provided', async () => {
      getLatestPrice.mockResolvedValue({ price: 50000, source: 'API:TwelveData' });

      await request(app)
        .get('/api/pricing/prices')
        .set('X-API-KEY', API_KEY)
        .query({ symbol: 'BTC', assetType: 'API_CRYPTO', currency: 'USD', exchange: 'XNAS' });

      expect(getLatestPrice).toHaveBeenCalledWith('BTC', 'API_CRYPTO', 'USD', { exchange: 'XNAS' });
    });

    it('returns 404 when price is not found', async () => {
      getLatestPrice.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/pricing/prices')
        .set('X-API-KEY', API_KEY)
        .query({ symbol: 'UNKNOWN', assetType: 'API_STOCK' });

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/Price not found/i);
    });

    it('returns 500 when service throws an error', async () => {
      getLatestPrice.mockRejectedValue(new Error('API timeout'));

      const res = await request(app)
        .get('/api/pricing/prices')
        .set('X-API-KEY', API_KEY)
        .query({ symbol: 'AAPL', assetType: 'API_STOCK' });

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/internal error/i);
    });
  });
});
