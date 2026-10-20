/**
 * Unit tests for the eToro HTTP client, response parsers and holdings builder
 * in `@bliss/shared/etoro` (#143), against the ESM build. `fetch` is mocked;
 * response shapes follow the spike's live runs.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createEtoroClient,
  parseMe,
  parseCopies,
  parseWaitMs,
  buildCopyHoldings,
  EtoroError,
  isKeyInvalid,
  ETORO_PATHS,
  INSTRUMENT_BATCH_SIZE,
} from '@bliss/shared/etoro';

type Res = { status: number; body?: unknown; headers?: Record<string, string> };

const response = ({ status, body = {}, headers = {} }: Res) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

function harness(responses: Res[]) {
  const calls: Array<{ url: string; init: RequestInit & { headers: Record<string, string> } }> = [];
  const queue = [...responses];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit & { headers: Record<string, string> }) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error('unexpected request');
    return response(next);
  });
  const sleep = vi.fn(async () => {});
  let clock = 1_000_000;
  const client = createEtoroClient({
    apiKey: 'PUBLIC-KEY-1234',
    userKey: 'USER-KEY-SECRET',
    fetchImpl,
    sleep,
    now: () => clock,
  });
  return { client, calls, sleep, fetchImpl, advance: (ms: number) => { clock += ms; } };
}

describe('createEtoroClient', () => {
  it('sends the key pair and a fresh request id on every call, read-only', async () => {
    const { client, calls } = harness([
      { status: 200, body: { realCid: 42, username: 'Daniel', scopes: ['trade.real:read'] } },
      { status: 200, body: { mirrors: [] } },
    ]);
    await client.getMe();
    await client.getAggregatePortfolio();
    expect(calls[0].url).toBe(`https://public-api.etoro.com${ETORO_PATHS.me}`);
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers).toMatchObject({ 'x-api-key': 'PUBLIC-KEY-1234', 'x-user-key': 'USER-KEY-SECRET' });
    expect(calls[0].init.headers['x-request-id']).not.toBe(calls[1].init.headers['x-request-id']);
    // The aggregate request is a POST that asks for per-copy instrument detail.
    expect(calls[1].init.method).toBe('POST');
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ mirrorLevel: 'details', instrumentLevel: 'details' });
  });

  it('requires both keys', () => {
    expect(() => createEtoroClient({ apiKey: 'a' } as never)).toThrow(/required/);
  });

  it('maps 401/403 to KEY_INVALID, 5xx to UNAVAILABLE, others to HTTP_ERROR', async () => {
    for (const [status, code] of [[401, 'KEY_INVALID'], [403, 'KEY_INVALID'], [503, 'UNAVAILABLE'], [404, 'HTTP_ERROR']] as const) {
      const { client } = harness([{ status, body: { error: 'x' } }]);
      const err = await client.getMe().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EtoroError);
      expect((err as EtoroError).code).toBe(code);
      expect((err as EtoroError).status).toBe(status);
    }
    expect(isKeyInvalid(new EtoroError('KEY_INVALID', 'x'))).toBe(true);
    expect(new EtoroError('UNAVAILABLE', 'x').retryable).toBe(true);
    expect(new EtoroError('KEY_INVALID', 'x').retryable).toBe(false);
  });

  it('maps network errors and timeouts to UNAVAILABLE without leaking the keys', async () => {
    const fetchImpl = vi.fn(async () => { throw Object.assign(new Error('boom USER-KEY-SECRET'), { cause: { code: 'ECONNRESET' } }); });
    const client = createEtoroClient({ apiKey: 'PUBLIC-KEY-1234', userKey: 'USER-KEY-SECRET', fetchImpl });
    const err = await client.getMe().catch((e: unknown) => e) as EtoroError;
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.message).toContain('ECONNRESET');
    expect(JSON.stringify({ ...err, message: err.message })).not.toMatch(/USER-KEY-SECRET|PUBLIC-KEY-1234/);
  });

  it('treats a non-JSON 2xx as SHAPE_CHANGED', async () => {
    const { client } = harness([{ status: 200, body: '<html>maintenance</html>' }]);
    await expect(client.getAggregatePortfolio()).rejects.toMatchObject({ code: 'SHAPE_CHANGED' });
  });

  it('waits for the reset when one request is left (RateLimit-* headers)', async () => {
    const { client, sleep } = harness([
      { status: 200, body: { realCid: 1, scopes: [] }, headers: { 'ratelimit-remaining': '1', 'ratelimit-reset': '12' } },
      { status: 200, body: { realCid: 1, scopes: [] } },
    ]);
    await client.getMe();
    expect(sleep).not.toHaveBeenCalled();
    await client.getMe();
    expect(sleep).toHaveBeenCalledWith(12_000);
  });

  it('on a 429 waits Retry-After and retries once', async () => {
    const { client, sleep, fetchImpl } = harness([
      { status: 429, headers: { 'retry-after': '3' } },
      { status: 200, body: { realCid: 1, scopes: [] } },
    ]);
    await expect(client.getMe()).resolves.toMatchObject({ cid: '1' });
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a second 429, or a reset more than a minute away, is RATE_LIMITED', async () => {
    const twice = harness([{ status: 429, headers: { 'retry-after': '1' } }, { status: 429, headers: { 'retry-after': '1' } }]);
    await expect(twice.client.getMe()).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    const far = harness([{ status: 429, headers: { 'retry-after': '600' } }]);
    await expect(far.client.getMe()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(far.sleep).not.toHaveBeenCalled();
  });

  it('fetches instrument metadata in batches of 50 and dedupes ids', async () => {
    const ids = Array.from({ length: INSTRUMENT_BATCH_SIZE + 5 }, (_, i) => i + 1);
    const { client, calls } = harness([
      { status: 200, body: { instrumentDisplayDatas: ids.slice(0, 50).map((id) => ({ instrumentID: id, symbolFull: `S${id}` })) } },
      { status: 200, body: { instrumentDisplayDatas: ids.slice(50).map((id) => ({ instrumentID: id, symbolFull: `S${id}` })) } },
    ]);
    const meta = await client.getInstruments([...ids, 1, 2, NaN]);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0].url).searchParams.get('instrumentIds')?.split(',')).toHaveLength(50);
    expect(meta.size).toBe(55);
    expect(meta.get(55)).toMatchObject({ symbolFull: 'S55' });
  });
});

describe('parseWaitMs', () => {
  it('reads delta seconds, epoch seconds and HTTP dates', () => {
    expect(parseWaitMs('5', 0)).toBe(5000);
    expect(parseWaitMs(String(2_000_000_010), 2_000_000_000_000)).toBe(10_000);
    expect(parseWaitMs(new Date(60_000).toUTCString(), 0)).toBe(60_000);
    expect(parseWaitMs(null)).toBeNull();
    expect(parseWaitMs('soon')).toBeNull();
  });
});

describe('parseMe', () => {
  it('reads the real customer id, username and scopes', () => {
    expect(parseMe({ realCid: 123, demoCid: 9, username: 'Bliss', scopes: ['a:read', 7] }))
      .toEqual({ cid: '123', username: 'Bliss', scopes: ['a:read'] });
    expect(parseMe({ gcid: 5 })).toEqual({ cid: '5', username: null, scopes: [] });
  });

  it('refuses a body without a customer id', () => {
    expect(() => parseMe({ scopes: [] })).toThrow(EtoroError);
    expect(() => parseMe(null)).toThrow(/no body/);
  });
});

describe('parseCopies', () => {
  const aggregate = {
    accountCurrency: 'usd',
    mirrors: [
      { mirrorId: 0, mirrorTotals: { mirrorLiquidationValue: 99 } },
      {
        mirrorId: 11,
        mirrorTotals: { mirrorLiquidationValue: '2000.5' },
        mirrorAvailableCash: 100,
        instrumentAggregates: [{ instrumentId: 1001, liquidationValueAccountCurrency: 1500 }, { instrumentId: 'x' }],
      },
    ],
  };
  const portfolio = { clientPortfolio: { mirrors: [{ mirrorID: 11, parentUsername: 'TopInvestor', parentCID: 7, startedCopyDate: '2026-02-01T00:00:00Z' }] } };

  it('joins values and per-instrument detail with the copied investor, ignoring direct holdings', () => {
    expect(parseCopies(aggregate, portfolio)).toEqual({
      currency: 'USD',
      copies: [{
        mirrorId: '11',
        parentUsername: 'topinvestor',
        parentCid: '7',
        startedAt: new Date('2026-02-01T00:00:00Z'),
        value: 2000.5,
        cash: 100,
        instruments: [{ instrumentId: 1001, value: 1500 }],
      }],
    });
  });

  it('fails with SHAPE_CHANGED when eToro changes the response', () => {
    expect(() => parseCopies({})).toThrow(/no mirrors/);
    expect(() => parseCopies(aggregate, null)).toThrow(/copied investor/);
    expect(() => parseCopies({ mirrors: [{ mirrorId: 3, parentUsername: 'x' }] })).toThrow(/without a value/);
  });
});

describe('buildCopyHoldings', () => {
  const meta = new Map([
    [1, { symbolFull: 'AIR.PA', exchangeID: 9, instrumentTypeID: 5 }],
    [2, { symbolFull: 'XYZ', exchangeID: 99, instrumentTypeID: 5 }],
    [3, { symbolFull: 'BTC', exchangeID: 8, instrumentTypeID: 10 }],
  ]);

  it('maps each instrument and expresses values as a share of the copy', () => {
    const logger = { warn: vi.fn() };
    const r = buildCopyHoldings({
      value: 1000,
      cash: 50,
      instruments: [
        { instrumentId: 1, value: 600 },
        { instrumentId: 2, value: 100 },
        { instrumentId: 3, value: 200 },
        { instrumentId: 4, value: 50 }, // no metadata
        { instrumentId: 5, value: -10 }, // short / closed: skipped
      ],
    }, meta, { logger });
    expect(r.cashPct).toBe(5);
    expect(r.unmappedPct).toBe(15);
    expect(r.holdings.map((h: { instrumentId: number; valuePct: number }) => [h.instrumentId, h.valuePct])).toEqual([[1, 60], [3, 20], [2, 10], [4, 5]]);
    expect(r.holdings[0]).toMatchObject({ etoroSymbol: 'AIR.PA', symbol: 'AIR', exchange: 'XPAR', type: 'STOCK' });
    expect(r.holdings[1]).toMatchObject({ nonEquity: 'CRYPTO' });
    expect(r.holdings[2]).toMatchObject({ unresolved: true, reason: 'UNKNOWN_EXCHANGE' });
    expect(logger.warn).toHaveBeenCalledWith('etoro_unmapped_instrument', expect.objectContaining({ instrumentId: 2 }));
  });

  it('returns nothing for a copy without value', () => {
    expect(buildCopyHoldings({ value: 0, cash: 0, instruments: [{ instrumentId: 1, value: 5 }] }, meta))
      .toEqual({ holdings: [], cashPct: 0, unmappedPct: 0 });
  });
});
