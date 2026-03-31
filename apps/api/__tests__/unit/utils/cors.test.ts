import { describe, it, expect, vi, beforeEach } from 'vitest';

import { cors } from '../../../utils/cors.js';

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'GET',
    headers: {},
    ...overrides,
  } as any;
}

function makeRes() {
  const res: any = {};
  res.setHeader = vi.fn();
  res.status = vi.fn().mockReturnValue(res);
  res.end = vi.fn().mockReturnValue(res);
  return res;
}

describe('cors()', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalFrontendUrl = process.env.FRONTEND_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FRONTEND_URL = 'https://app.blissfinance.co';
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    process.env.FRONTEND_URL = originalFrontendUrl;
  });

  it('returns true and sends 200 for OPTIONS preflight', () => {
    const req = makeReq({ method: 'OPTIONS', headers: { origin: 'https://app.blissfinance.co' } });
    const res = makeRes();

    const result = cors(req, res);

    expect(result).toBe(true);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.end).toHaveBeenCalled();
  });

  it('returns false for non-OPTIONS requests', () => {
    const req = makeReq({ method: 'GET', headers: { origin: 'https://app.blissfinance.co' } });
    const res = makeRes();

    const result = cors(req, res);

    expect(result).toBe(false);
  });

  it('sets Allow-Origin for an allowed origin', () => {
    const req = makeReq({ headers: { origin: 'https://app.blissfinance.co' } });
    const res = makeRes();

    cors(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'https://app.blissfinance.co');
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Credentials', 'true');
  });

  it('does not set Allow-Origin for an unknown origin', () => {
    const req = makeReq({ headers: { origin: 'https://evil.com' } });
    const res = makeRes();

    cors(req, res);

    const originCalls = res.setHeader.mock.calls.filter(
      (c: string[]) => c[0] === 'Access-Control-Allow-Origin'
    );
    expect(originCalls).toHaveLength(0);
  });

  it('adds localhost origins in non-production', () => {
    process.env.NODE_ENV = 'development';
    const req = makeReq({ headers: { origin: 'http://localhost:3000' } });
    const res = makeRes();

    cors(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'http://localhost:3000');
  });

  it('sets Allow-Headers and Allow-Methods', () => {
    const req = makeReq({ headers: {} });
    const res = makeRes();

    cors(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Headers', expect.stringContaining('Content-Type'));
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Methods', expect.stringContaining('GET'));
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Methods', expect.stringContaining('POST'));
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Methods', expect.stringContaining('DELETE'));
  });
});
