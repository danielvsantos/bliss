import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy(
    {},
    {
      get: () => (_req: any, _res: any, next: Function) => next(),
    },
  ),
}));

vi.mock('../../../utils/cors.js', () => ({
  cors: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../utils/cookieUtils.js', () => ({
  clearAuthCookie: vi.fn(),
}));

vi.mock('../../../utils/denylist.js', () => ({
  addToDenylist: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('jsonwebtoken', () => ({
  default: { decode: vi.fn() },
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import jwt from 'jsonwebtoken';
import { clearAuthCookie } from '../../../utils/cookieUtils.js';
import { addToDenylist } from '../../../utils/denylist.js';
import handler from '../../../pages/api/auth/signout.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(overrides: Record<string, unknown> = {}) {
  return { method: 'POST', cookies: {}, headers: {}, ...overrides } as any;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.end = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn();
  return res;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/auth/signout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 405 for non-POST methods', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['POST']);
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.end).toHaveBeenCalledWith('Method GET Not Allowed');
  });

  it('returns 200 and clears auth cookie on POST', async () => {
    const req = makeReq();
    const res = makeRes();

    await handler(req, res);

    expect(clearAuthCookie).toHaveBeenCalledWith(res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ message: 'Signed out successfully' });
  });

  it('decodes token and adds jti to denylist with correct TTL', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    (jwt.decode as ReturnType<typeof vi.fn>).mockReturnValue({
      jti: 'abc-123',
      exp: futureExp,
    });

    const req = makeReq({ cookies: { token: 'some-jwt-token' } });
    const res = makeRes();

    await handler(req, res);

    expect(jwt.decode).toHaveBeenCalledWith('some-jwt-token');
    expect(addToDenylist).toHaveBeenCalledWith(
      'abc-123',
      expect.any(Number),
    );

    // TTL should be close to 3600 (allow a few seconds of clock drift)
    const actualTtl = (addToDenylist as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(actualTtl).toBeGreaterThan(3590);
    expect(actualTtl).toBeLessThanOrEqual(3600);

    expect(clearAuthCookie).toHaveBeenCalledWith(res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('succeeds when no token is present', async () => {
    const req = makeReq({ cookies: {} });
    const res = makeRes();

    await handler(req, res);

    expect(jwt.decode).not.toHaveBeenCalled();
    expect(addToDenylist).not.toHaveBeenCalled();
    expect(clearAuthCookie).toHaveBeenCalledWith(res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ message: 'Signed out successfully' });
  });

  it('succeeds when addToDenylist fails', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    (jwt.decode as ReturnType<typeof vi.fn>).mockReturnValue({
      jti: 'abc-123',
      exp: futureExp,
    });
    (addToDenylist as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Redis down'),
    );

    const req = makeReq({ cookies: { token: 'some-jwt-token' } });
    const res = makeRes();

    await handler(req, res);

    expect(addToDenylist).toHaveBeenCalled();
    expect(clearAuthCookie).toHaveBeenCalledWith(res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ message: 'Signed out successfully' });
  });

  it('returns 500 on unexpected error', async () => {
    (clearAuthCookie as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('Unexpected failure');
    });

    const req = makeReq();
    const res = makeRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Sign out failed' }),
    );
  });
});
