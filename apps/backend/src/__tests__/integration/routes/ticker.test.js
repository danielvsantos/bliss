/**
 * Integration tests for GET /api/ticker/search and GET /api/ticker/profile
 *
 * Tests the full Express route stack: CORS middleware -> apiKeyAuth -> route handler.
 * The twelveDataService is mocked so these tests focus on the HTTP contract,
 * not the external API integration.
 *
 * No database setup required for this test file.
 */

jest.mock('../../../services/twelveDataService', () => ({
  searchSymbol: jest.fn(),
  getSymbolProfile: jest.fn(),
}));

jest.mock('../../../services/securityMasterService', () => ({
  getBySymbol: jest.fn().mockResolvedValue(null),
  upsertFromProfile: jest.fn().mockResolvedValue(undefined),
}));

const request = require('supertest');
const app = require('../../../app');
const twelveDataService = require('../../../services/twelveDataService');

const API_KEY = process.env.INTERNAL_API_KEY;

describe('GET /api/ticker/search', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when X-API-KEY header is missing', async () => {
    const res = await request(app).get('/api/ticker/search?q=AAPL');

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 400 when q query param is missing', async () => {
    const res = await request(app)
      .get('/api/ticker/search')
      .set('X-API-KEY', API_KEY);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/q query parameter is required/i);
  });

  it('returns 200 with search results', async () => {
    const mockResults = [
      {
        symbol: 'AAPL',
        name: 'Apple Inc',
        exchange: 'NASDAQ',
        country: 'United States',
        currency: 'USD',
        type: 'Common Stock',
        mic_code: 'XNGS',
      },
      {
        symbol: 'AAPL.MX',
        name: 'Apple Inc',
        exchange: 'BMV',
        country: 'Mexico',
        currency: 'MXN',
        type: 'Common Stock',
        mic_code: 'XMEX',
      },
    ];

    twelveDataService.searchSymbol.mockResolvedValue(mockResults);

    const res = await request(app)
      .get('/api/ticker/search?q=AAPL')
      .set('X-API-KEY', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: mockResults });
    expect(twelveDataService.searchSymbol).toHaveBeenCalledWith('AAPL');
  });

  it('returns 200 with empty results array when no matches found', async () => {
    twelveDataService.searchSymbol.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/ticker/search?q=ZZZZNOTREAL')
      .set('X-API-KEY', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
    expect(twelveDataService.searchSymbol).toHaveBeenCalledWith('ZZZZNOTREAL');
  });

  it('trims whitespace from the q query param', async () => {
    twelveDataService.searchSymbol.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/ticker/search?q=%20VWCE%20')
      .set('X-API-KEY', API_KEY);

    expect(res.status).toBe(200);
    expect(twelveDataService.searchSymbol).toHaveBeenCalledWith('VWCE');
  });

  it('returns 500 when the service throws an error', async () => {
    twelveDataService.searchSymbol.mockRejectedValue(new Error('Network timeout'));

    const res = await request(app)
      .get('/api/ticker/search?q=AAPL')
      .set('X-API-KEY', API_KEY);

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Failed to search symbols' });
  });
});

describe('GET /api/ticker/profile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when X-API-KEY header is missing', async () => {
    const res = await request(app).get('/api/ticker/profile?symbol=AAPL');

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 400 when symbol query param is missing', async () => {
    const res = await request(app)
      .get('/api/ticker/profile')
      .set('X-API-KEY', API_KEY);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/symbol query parameter is required/i);
  });

  it('returns 200 with a valid profile', async () => {
    const mockProfile = {
      isin: 'US0378331005',
      exchange: 'NASDAQ',
      micCode: 'XNGS',
      name: 'Apple Inc',
      currency: 'USD',
      sector: 'Technology',
      type: 'Common Stock',
    };

    twelveDataService.getSymbolProfile.mockResolvedValue(mockProfile);

    const res = await request(app)
      .get('/api/ticker/profile?symbol=AAPL')
      .set('X-API-KEY', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockProfile);
    expect(twelveDataService.getSymbolProfile).toHaveBeenCalledWith('AAPL', { micCode: undefined });
  });

  it('returns 404 when profile is not found (service returns null)', async () => {
    twelveDataService.getSymbolProfile.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/ticker/profile?symbol=XYZNOTREAL')
      .set('X-API-KEY', API_KEY);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no profile found/i);
    expect(twelveDataService.getSymbolProfile).toHaveBeenCalledWith('XYZNOTREAL', { micCode: undefined });
  });

  it('trims whitespace from the symbol query param', async () => {
    twelveDataService.getSymbolProfile.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/ticker/profile?symbol=%20VWCE.DEX%20')
      .set('X-API-KEY', API_KEY);

    expect(res.status).toBe(404);
    expect(twelveDataService.getSymbolProfile).toHaveBeenCalledWith('VWCE.DEX', { micCode: undefined });
  });

  it('returns 500 when the service throws an error', async () => {
    twelveDataService.getSymbolProfile.mockRejectedValue(new Error('API unavailable'));

    const res = await request(app)
      .get('/api/ticker/profile?symbol=AAPL')
      .set('X-API-KEY', API_KEY);

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Failed to fetch symbol profile' });
  });
});
