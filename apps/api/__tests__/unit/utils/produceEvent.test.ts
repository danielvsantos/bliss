import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Sentry from '@sentry/nextjs';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock('node-fetch', () => ({
  default: mockFetch,
}));

import { produceEvent } from '../../../utils/produceEvent.js';

describe('produceEvent', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(Sentry.captureMessage).mockClear();
  });

  it('POSTs to BACKEND_URL/api/events with x-api-key header', async () => {
    mockFetch.mockResolvedValue({ ok: true });

    await produceEvent({ type: 'TEST_EVENT', payload: {} });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3001/api/events');
    expect(options.method).toBe('POST');
    expect(options.headers['x-api-key']).toBeDefined();
    expect(options.headers['Content-Type']).toBe('application/json');
  });

  it('includes event as JSON body', async () => {
    mockFetch.mockResolvedValue({ ok: true });

    const event = { type: 'SYNC_TRANSACTIONS', payload: { tenantId: 1 } };
    await produceEvent(event);

    const [, options] = mockFetch.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual(event);
  });

  it('catches network errors without throwing and calls Sentry.captureException', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(produceEvent({ type: 'FAIL_EVENT', payload: {} })).resolves.toBeUndefined();

    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledOnce();
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'ECONNREFUSED' }),
      expect.objectContaining({
        extra: expect.objectContaining({ eventType: 'FAIL_EVENT' }),
      }),
    );
  });

  it('reports non-2xx responses via Sentry.captureMessage', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue('Unauthorized'),
    });

    await produceEvent({ type: 'AUTH_EVENT', payload: {} });

    expect(vi.mocked(Sentry.captureMessage)).toHaveBeenCalledOnce();
    expect(vi.mocked(Sentry.captureMessage)).toHaveBeenCalledWith(
      expect.stringContaining('401'),
      expect.objectContaining({
        level: 'error',
        extra: expect.objectContaining({
          eventType: 'AUTH_EVENT',
          status: 401,
          body: 'Unauthorized',
        }),
      }),
    );
  });

  it('does not throw when fetch succeeds with 200', async () => {
    mockFetch.mockResolvedValue({ ok: true });

    await expect(produceEvent({ type: 'OK_EVENT', payload: {} })).resolves.toBeUndefined();

    expect(vi.mocked(Sentry.captureException)).not.toHaveBeenCalled();
    expect(vi.mocked(Sentry.captureMessage)).not.toHaveBeenCalled();
  });
});
