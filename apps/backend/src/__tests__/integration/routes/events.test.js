/**
 * Integration tests for POST /api/events
 *
 * Tests the full Express route stack: CORS middleware → apiKeyAuth → route handler.
 * The BullMQ events queue is mocked so tests focus on the HTTP contract without
 * requiring a live Redis connection.
 *
 * No database setup required for this test file.
 */

const request = require('supertest');

// Mock the events queue — prevents Redis connection in tests
jest.mock('../../../queues/eventsQueue', () => ({
  enqueueEvent: jest.fn().mockResolvedValue({ id: 'mock-job-id' }),
}));

const app = require('../../../app');
const { enqueueEvent } = require('../../../queues/eventsQueue');

const API_KEY = process.env.INTERNAL_API_KEY;

describe('POST /api/events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when X-API-KEY header is missing', async () => {
    const res = await request(app)
      .post('/api/events')
      .send({ type: 'TRANSACTIONS_IMPORTED', tenantId: 'tenant-1' });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 401 when X-API-KEY is incorrect', async () => {
    const res = await request(app)
      .post('/api/events')
      .set('X-API-KEY', 'bad-key')
      .send({ type: 'TRANSACTIONS_IMPORTED', tenantId: 'tenant-1' });

    expect(res.status).toBe(401);
  });

  it('returns 400 when event type is missing', async () => {
    const res = await request(app)
      .post('/api/events')
      .set('X-API-KEY', API_KEY)
      .send({ tenantId: 'tenant-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/type/i);
  });

  it('returns 202 and enqueues the event with valid payload', async () => {
    const res = await request(app)
      .post('/api/events')
      .set('X-API-KEY', API_KEY)
      .send({ type: 'TRANSACTIONS_IMPORTED', tenantId: 'tenant-abc', plaidItemId: 'item-1' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ message: 'Event accepted' });

    // enqueueEvent receives type + remaining body fields as data
    expect(enqueueEvent).toHaveBeenCalledWith('TRANSACTIONS_IMPORTED', {
      tenantId: 'tenant-abc',
      plaidItemId: 'item-1',
    });
  });

  it('returns 202 for events without extra data fields', async () => {
    const res = await request(app)
      .post('/api/events')
      .set('X-API-KEY', API_KEY)
      .send({ type: 'SYNC_PORTFOLIO' });

    expect(res.status).toBe(202);
    expect(enqueueEvent).toHaveBeenCalledWith('SYNC_PORTFOLIO', {});
  });
});
