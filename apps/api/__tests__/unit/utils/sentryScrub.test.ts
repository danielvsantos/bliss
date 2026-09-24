import { describe, it, expect } from 'vitest';

import { scrubEvent } from '../../../utils/sentryScrub.js';

/**
 * Builds a Sentry event shaped like the ones the SDK produces for an axios
 * failure: the message and stacktrace live on `exception.values[0]`, and the
 * non-Error properties the SDK found on the thrown object (here, the axios
 * `config`) land under `mechanism.data`.
 */
function axiosShapedEvent() {
  return {
    exception: {
      values: [
        {
          type: 'AxiosError',
          value: 'Request failed with status code 500',
          stacktrace: { frames: [{ filename: 'llmClient.js', lineno: 42 }] },
          mechanism: {
            type: 'generic',
            handled: true,
            data: {
              config: {
                url: 'https://api.provider.example/v1/classify',
                data: '{"description":"TESCO STORES 3421 LONDON"}',
                headers: { authorization: 'Bearer sk-live-abc123', 'x-api-key': 'secret' },
              },
              status: 500,
            },
          },
        },
      ],
    },
  } as any;
}

describe('scrubEvent', () => {
  describe('removes sensitive payloads', () => {
    it('strips the axios config envelope from mechanism.data', () => {
      const event = scrubEvent(axiosShapedEvent());
      const data = event.exception.values[0].mechanism.data;

      expect(data.config).toBe('[redacted]');
      expect(JSON.stringify(event)).not.toContain('TESCO STORES');
      expect(JSON.stringify(event)).not.toContain('sk-live-abc123');
    });

    it('strips top-level config / response / headers containers', () => {
      const event = scrubEvent({
        config: { data: 'secret-body' },
        response: { data: 'secret-body' },
        headers: { authorization: 'Bearer x' },
        message: 'boom',
      } as any);

      expect(event.config).toBeUndefined();
      expect(event.response).toBeUndefined();
      expect(event.headers).toBeUndefined();
      expect(event.message).toBe('boom');
    });

    // A nested `request` is an axios error's own property and must go.
    it('redacts a request envelope nested inside the event tree', () => {
      const event = scrubEvent({
        extra: {
          err: { request: { _header: 'GET / HTTP/1.1\r\nx-api-key: secret-key' } },
        },
      } as any);

      expect((event as any).extra.err.request).toBe('[redacted]');
      expect(JSON.stringify(event)).not.toContain('secret-key');
    });
  });

  // Sentry's top-level `request` is its own Request context — url, method,
  // headers, cookies, data — NOT an error's leaked property. Deleting it
  // wholesale threw away which endpoint was called, which is exactly the
  // over-scrubbing this hook is supposed to avoid.
  describe('sanitizes rather than deletes the top-level request context', () => {
    it('keeps the path and method', () => {
      const event = scrubEvent({
        request: { url: 'https://api.example.com/api/transactions', method: 'POST' },
      } as any);

      expect((event as any).request).toEqual({
        url: 'https://api.example.com/api/transactions',
        method: 'POST',
      });
    });

    it('drops headers, cookies, data and env', () => {
      const event = scrubEvent({
        request: {
          url: '/api/transactions',
          method: 'POST',
          headers: { 'x-api-key': 'secret-key', cookie: 'token=abc' },
          cookies: { token: 'abc' },
          data: { description: 'TESCO STORES 3421' },
          env: { SERVER_NAME: 'api-1' },
        },
      } as any);

      const request = (event as any).request;
      expect(request).toEqual({ url: '/api/transactions', method: 'POST' });
      expect(JSON.stringify(event)).not.toContain('secret-key');
      expect(JSON.stringify(event)).not.toContain('TESCO STORES');
    });

    // Bliss list endpoints accept search and filter params, which can echo the
    // plaintext of fields that are encrypted at rest.
    it('strips the query string from the url', () => {
      const event = scrubEvent({
        request: {
          url: '/api/transactions?search=TESCO%20STORES&page=2',
          method: 'GET',
          query_string: 'search=TESCO%20STORES&page=2',
        },
      } as any);

      expect((event as any).request.url).toBe('/api/transactions');
      expect((event as any).request.query_string).toBeUndefined();
      expect(JSON.stringify(event)).not.toContain('TESCO');
    });

    it('handles a request context with no url or method', () => {
      const event = scrubEvent({ request: { headers: { cookie: 'x' } } } as any);
      expect((event as any).request).toEqual({});
    });

    it('redacts denylisted keys nested deep inside extra', () => {
      // This is the Prisma shape: field encryption is middleware, so the
      // offending query payload holds DECRYPTED values.
      const event = scrubEvent({
        extra: {
          prisma: {
            model: 'Transaction',
            args: {
              data: {
                amount: 12.5,
                description: 'AMAZON MKTPLACE PMTS',
                accountNumber: 'GB29NWBK60161331926819',
              },
            },
          },
        },
      } as any);

      const data = (event as any).extra.prisma.args.data;
      expect(data.description).toBe('[redacted]');
      expect(data.accountNumber).toBe('[redacted]');
      // Non-sensitive siblings survive — the issue must stay debuggable.
      expect(data.amount).toBe(12.5);
    });

    it('redacts composed credential names by suffix', () => {
      const event = scrubEvent({
        extra: {
          plaidAccessToken: 'access-sandbox-xyz',
          llmApiKey: 'sk-live-1',
          jwtSecret: 'nope',
          userPassword: 'hunter2',
          tenantId: 'tenant-1',
        },
      } as any);

      const extra = (event as any).extra;
      expect(extra.plaidAccessToken).toBe('[redacted]');
      expect(extra.llmApiKey).toBe('[redacted]');
      expect(extra.jwtSecret).toBe('[redacted]');
      expect(extra.userPassword).toBe('[redacted]');
      expect(extra.tenantId).toBe('tenant-1');
    });

    it('truncates very long strings', () => {
      const event = scrubEvent({ extra: { blob: 'x'.repeat(10_000) } } as any);
      const blob = (event as any).extra.blob as string;

      expect(blob.length).toBeLessThan(10_000);
      expect(blob.endsWith('[truncated]')).toBe(true);
    });

    it('scrubs breadcrumbs, tags and contexts', () => {
      const event = scrubEvent({
        breadcrumbs: [{ category: 'http', data: { url: '/x', authorization: 'Bearer y' } }],
        tags: { apiKey: 'leak' },
        contexts: { custom: { accessToken: 'leak' } },
      } as any);

      expect((event as any).breadcrumbs[0].data.authorization).toBe('[redacted]');
      expect((event as any).tags.apiKey).toBe('[redacted]');
      expect((event as any).contexts.custom.accessToken).toBe('[redacted]');
    });
  });

  describe('keeps the event debuggable', () => {
    it('preserves the exception message and stacktrace', () => {
      const event = scrubEvent(axiosShapedEvent());
      const entry = event.exception.values[0];

      expect(entry.value).toBe('Request failed with status code 500');
      expect(entry.stacktrace.frames[0].filename).toBe('llmClient.js');
      expect(entry.type).toBe('AxiosError');
    });

    it('truncates — but does not delete — an oversized exception message', () => {
      const event = scrubEvent({
        exception: { values: [{ value: 'y'.repeat(10_000), stacktrace: { frames: [] } }] },
      } as any);
      const value = event.exception.values[0].value as string;

      expect(value.startsWith('yyy')).toBe(true);
      expect(value.endsWith('[truncated]')).toBe(true);
    });
  });

  describe('never drops an event', () => {
    // beforeSend returning null drops the event silently and permanently, so a
    // bug in the hook would be invisible by construction.
    it('survives a circular reference without throwing', () => {
      const circular: any = { name: 'loop' };
      circular.self = circular;

      let event: any;
      expect(() => {
        event = scrubEvent({ extra: { circular } } as any);
      }).not.toThrow();

      expect(event).not.toBeNull();
      expect(event.extra.circular.self).toBe('[circular]');
    });

    it('returns the original event when an internal operation throws', () => {
      // A getter that throws models any unexpected internal failure.
      const hostile: any = {};
      Object.defineProperty(hostile, 'boom', {
        enumerable: true,
        get() {
          throw new Error('nope');
        },
      });

      const event = { extra: hostile, message: 'still here' } as any;
      let result: any;

      expect(() => {
        result = scrubEvent(event);
      }).not.toThrow();

      expect(result).not.toBeNull();
      expect(result.message).toBe('still here');
    });

    it('passes through null / undefined / non-object inputs unchanged', () => {
      expect(scrubEvent(null as any)).toBeNull();
      expect(scrubEvent(undefined as any)).toBeUndefined();
      expect(scrubEvent('not-an-event' as any)).toBe('not-an-event');
    });

    it('returns a non-null event for a minimal, empty event', () => {
      const event = scrubEvent({} as any);
      expect(event).toEqual({});
    });

    it('handles an event with no exception.values array', () => {
      const event = scrubEvent({ exception: {}, message: 'plain' } as any);
      expect(event.message).toBe('plain');
    });
  });
});
