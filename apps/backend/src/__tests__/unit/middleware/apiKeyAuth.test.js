const apiKeyAuth = require('../../../middleware/apiKeyAuth');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(headers = {}) {
  return { headers };
}

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('apiKeyAuth middleware', () => {
  const ORIGINAL_KEY = process.env.INTERNAL_API_KEY;

  beforeEach(() => {
    process.env.INTERNAL_API_KEY = 'test-secret-key';
  });

  afterAll(() => {
    process.env.INTERNAL_API_KEY = ORIGINAL_KEY;
  });

  it('calls next() when X-API-KEY matches INTERNAL_API_KEY', () => {
    const req = makeReq({ 'x-api-key': 'test-secret-key' });
    const res = makeRes();
    const next = jest.fn();

    apiKeyAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 when X-API-KEY header is missing', () => {
    const req = makeReq({});
    const res = makeRes();
    const next = jest.fn();

    apiKeyAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when X-API-KEY is an empty string', () => {
    const req = makeReq({ 'x-api-key': '' });
    const res = makeRes();
    const next = jest.fn();

    apiKeyAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when X-API-KEY does not match INTERNAL_API_KEY', () => {
    const req = makeReq({ 'x-api-key': 'wrong-key' });
    const res = makeRes();
    const next = jest.fn();

    apiKeyAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('does not call next() on auth failure', () => {
    const req = makeReq({ 'x-api-key': 'bad' });
    const res = makeRes();
    const next = jest.fn();

    apiKeyAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
  });

  // The comparison is constant-time via crypto.timingSafeEqual, which THROWS
  // when the two buffers differ in length. Without the length guard, a
  // wrong-length key would surface as an unhandled throw (a 500) instead of a
  // 401 — a worse response and a louder oracle than the timing leak it closes.
  describe('constant-time comparison matrix', () => {
    const EXPECTED = 'test-secret-key';

    const cases = [
      ['the correct key', EXPECTED, 200],
      ['a wrong key of the SAME length', 'test-secret-XXX', 401],
      ['a wrong key of a DIFFERENT length', 'x', 401],
      ['a wrong key much longer than expected', 'x'.repeat(4096), 401],
      ['no header at all', undefined, 401],
    ];

    it.each(cases)('returns %s → %s without throwing', (_label, key, expectedStatus) => {
      const req = makeReq(key === undefined ? {} : { 'x-api-key': key });
      const res = makeRes();
      const next = jest.fn();

      expect(() => apiKeyAuth(req, res, next)).not.toThrow();

      if (expectedStatus === 200) {
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
      } else {
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.status).not.toHaveBeenCalledWith(500);
        expect(next).not.toHaveBeenCalled();
      }
    });

    it('returns 401 rather than 500 when INTERNAL_API_KEY is unset', () => {
      delete process.env.INTERNAL_API_KEY;
      const req = makeReq({ 'x-api-key': 'anything' });
      const res = makeRes();
      const next = jest.fn();

      expect(() => apiKeyAuth(req, res, next)).not.toThrow();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 for a non-string header value (array) without throwing', () => {
      // Node collapses repeated headers into an array for some header names.
      const req = makeReq({ 'x-api-key': [EXPECTED, 'other'] });
      const res = makeRes();
      const next = jest.fn();

      expect(() => apiKeyAuth(req, res, next)).not.toThrow();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  it('reads INTERNAL_API_KEY from env at call time (not cached)', () => {
    const req = makeReq({ 'x-api-key': 'new-key' });
    const res = makeRes();
    const next = jest.fn();

    // Change env after module load
    process.env.INTERNAL_API_KEY = 'new-key';

    apiKeyAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
