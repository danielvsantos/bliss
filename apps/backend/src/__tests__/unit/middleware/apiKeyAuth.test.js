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
