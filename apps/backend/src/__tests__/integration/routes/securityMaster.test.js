/**
 * Integration tests for /api/security-master routes
 *
 * Tests the full Express route stack: CORS middleware -> apiKeyAuth -> route handler.
 * The securityMasterService and securityMasterQueue are mocked so tests focus on
 * the HTTP contract without requiring a live database or Redis connection.
 */

const request = require('supertest');

// Mock dependencies — prevents Redis/DB connections in tests
jest.mock('../../../services/securityMasterService', () => ({
  getBySymbol: jest.fn(),
  getBySymbols: jest.fn(),
}));
jest.mock('../../../queues/securityMasterQueue', () => ({
  enqueueSecurityMasterJob: jest.fn().mockResolvedValue({ id: 'mock-job-id' }),
}));

const app = require('../../../app');
const securityMasterService = require('../../../services/securityMasterService');
const { enqueueSecurityMasterJob } = require('../../../queues/securityMasterQueue');

const API_KEY = process.env.INTERNAL_API_KEY;

describe('/api/security-master routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── Auth ──────────────────────────────────────────────────────────────────

  describe('authentication', () => {
    it('GET / returns 401 without X-API-KEY header', async () => {
      const res = await request(app)
        .get('/api/security-master')
        .query({ symbol: 'AAPL' });

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: 'Unauthorized' });
    });

    it('GET /bulk returns 401 without X-API-KEY header', async () => {
      const res = await request(app)
        .get('/api/security-master/bulk')
        .query({ symbols: 'AAPL,MSFT' });

      expect(res.status).toBe(401);
    });

    it('POST /refresh returns 401 without X-API-KEY header', async () => {
      const res = await request(app)
        .post('/api/security-master/refresh')
        .send({ symbol: 'AAPL' });

      expect(res.status).toBe(401);
    });

    it('POST /refresh-all returns 401 without X-API-KEY header', async () => {
      const res = await request(app)
        .post('/api/security-master/refresh-all');

      expect(res.status).toBe(401);
    });
  });

  // ─── GET / ────────────────────────────────────────────────────────────────

  describe('GET /api/security-master', () => {
    it('returns 400 without symbol query param', async () => {
      const res = await request(app)
        .get('/api/security-master')
        .set('X-API-KEY', API_KEY);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/symbol/i);
    });

    it('returns 400 with empty symbol param', async () => {
      const res = await request(app)
        .get('/api/security-master')
        .set('X-API-KEY', API_KEY)
        .query({ symbol: '  ' });

      expect(res.status).toBe(400);
    });

    it('returns 200 with SecurityMaster record for valid symbol', async () => {
      const mockRecord = { symbol: 'AAPL', name: 'Apple Inc.', sector: 'Technology' };
      securityMasterService.getBySymbol.mockResolvedValue(mockRecord);

      const res = await request(app)
        .get('/api/security-master')
        .set('X-API-KEY', API_KEY)
        .query({ symbol: 'AAPL' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockRecord);
      expect(securityMasterService.getBySymbol).toHaveBeenCalledWith('AAPL');
    });

    it('returns 404 when symbol not found', async () => {
      securityMasterService.getBySymbol.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/security-master')
        .set('X-API-KEY', API_KEY)
        .query({ symbol: 'UNKNOWN' });

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/No SecurityMaster record/i);
    });
  });

  // ─── GET /bulk ─────────────────────────────────────────────────────────────

  describe('GET /api/security-master/bulk', () => {
    it('returns 400 without symbols query param', async () => {
      const res = await request(app)
        .get('/api/security-master/bulk')
        .set('X-API-KEY', API_KEY);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/symbols/i);
    });

    it('returns 200 with array of records for valid symbols', async () => {
      const mockRecords = [
        { symbol: 'AAPL', name: 'Apple Inc.' },
        { symbol: 'MSFT', name: 'Microsoft Corp.' },
      ];
      securityMasterService.getBySymbols.mockResolvedValue(mockRecords);

      const res = await request(app)
        .get('/api/security-master/bulk')
        .set('X-API-KEY', API_KEY)
        .query({ symbols: 'AAPL,MSFT' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockRecords);
      expect(securityMasterService.getBySymbols).toHaveBeenCalledWith(['AAPL', 'MSFT']);
    });

    it('trims whitespace from symbol list', async () => {
      securityMasterService.getBySymbols.mockResolvedValue([]);

      await request(app)
        .get('/api/security-master/bulk')
        .set('X-API-KEY', API_KEY)
        .query({ symbols: ' AAPL , MSFT ' });

      expect(securityMasterService.getBySymbols).toHaveBeenCalledWith(['AAPL', 'MSFT']);
    });
  });

  // ─── POST /refresh ────────────────────────────────────────────────────────

  describe('POST /api/security-master/refresh', () => {
    it('returns 400 when symbol is missing from body', async () => {
      const res = await request(app)
        .post('/api/security-master/refresh')
        .set('X-API-KEY', API_KEY)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/symbol/i);
    });

    it('returns 202 and enqueues refresh job for valid symbol', async () => {
      const res = await request(app)
        .post('/api/security-master/refresh')
        .set('X-API-KEY', API_KEY)
        .send({ symbol: 'AAPL' });

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ message: 'Refresh job enqueued' });
      expect(res.body.jobId).toBe('mock-job-id');
      expect(enqueueSecurityMasterJob).toHaveBeenCalledWith('refresh-single-symbol', {
        symbol: 'AAPL',
        exchange: null,
      });
    });

    it('passes exchange to job data when provided', async () => {
      await request(app)
        .post('/api/security-master/refresh')
        .set('X-API-KEY', API_KEY)
        .send({ symbol: 'SAP', exchange: 'XETR' });

      expect(enqueueSecurityMasterJob).toHaveBeenCalledWith('refresh-single-symbol', {
        symbol: 'SAP',
        exchange: 'XETR',
      });
    });
  });

  // ─── POST /refresh-all ────────────────────────────────────────────────────

  describe('POST /api/security-master/refresh-all', () => {
    it('returns 202 and enqueues refresh-all job', async () => {
      const res = await request(app)
        .post('/api/security-master/refresh-all')
        .set('X-API-KEY', API_KEY);

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ message: 'Full refresh job enqueued' });
      expect(res.body.jobId).toBe('mock-job-id');
      expect(enqueueSecurityMasterJob).toHaveBeenCalledWith('refresh-all-fundamentals', {});
    });
  });
});
