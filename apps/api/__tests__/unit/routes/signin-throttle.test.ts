/**
 * #78 R1/R3/R7/R9/R11 — the real express-rate-limit behind /api/auth/signin,
 * signout and the 429 CORS handler (D8). Only the database, the password
 * check and the session service are mocked; the limiters and CORS are real.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockAuth, mockSession, mockSentry } = vi.hoisted(() => ({
  mockPrisma: { user: { findFirst: vi.fn() } },
  mockAuth: { verifyAndUpgrade: vi.fn() },
  mockSession: { startSession: vi.fn(), revokeSession: vi.fn() },
  mockSentry: { captureException: vi.fn(), init: vi.fn() },
}));

vi.mock('@sentry/nextjs', () => mockSentry);
vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));
vi.mock('../../../services/auth.service', () => ({ AuthService: mockAuth }));
vi.mock('../../../services/session.service.js', () => mockSession);
vi.mock('../../../utils/denylist.js', () => ({ addToDenylist: vi.fn() }));

const FRONTEND = 'http://localhost:8080';

type Res = EventEmitter & {
  statusCode: number;
  headersSent: boolean;
  _body?: any;
  _headers: Record<string, unknown>;
  status: (c: number) => Res;
  json: (b: unknown) => Res;
  send: (b: unknown) => Res;
  end: (b?: unknown) => Res;
  setHeader: (n: string, v: unknown) => Res;
  getHeader: (n: string) => unknown;
  removeHeader: (n: string) => void;
};

function makeRes(): Res {
  const res = new EventEmitter() as Res;
  res.statusCode = 200;
  res.headersSent = false;
  res._headers = {};
  const finish = () => { res.headersSent = true; setImmediate(() => res.emit('finish')); return res; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res._body = b; return finish(); };
  res.send = (b) => { res._body = b; return finish(); };
  res.end = (b) => { res._body = b ?? res._body; return finish(); };
  res.setHeader = (n, v) => { res._headers[n.toLowerCase()] = v; return res; };
  res.getHeader = (n) => res._headers[n.toLowerCase()];
  res.removeHeader = (n) => { delete res._headers[n.toLowerCase()]; };
  return res;
}

function makeReq(overrides: Record<string, any> = {}) {
  return {
    method: 'POST',
    url: '/api/auth/signin',
    cookies: {},
    headers: { origin: FRONTEND, ...(overrides.headers || {}) },
    socket: { remoteAddress: overrides.ip ?? '203.0.113.10' },
    body: overrides.body ?? { email: 'ana@example.com', password: 'wrong-password' },
    ...(overrides.method ? { method: overrides.method } : {}),
  } as any;
}

/** Runs a handler until it answers (a limiter that refuses never calls next). */
async function call(handler: (req: any, res: any) => Promise<unknown>, req: any) {
  const res = makeRes();
  await Promise.race([
    handler(req, res),
    new Promise<void>((resolve) => res.once('finish', () => resolve())),
  ]);
  await new Promise((r) => setImmediate(r));
  return res;
}

async function freshModules() {
  vi.resetModules();
  const signin = (await import('../../../pages/api/auth/signin.js')).default;
  const signout = (await import('../../../pages/api/auth/signout.js')).default;
  const { createRateLimiter } = await import('../../../utils/rateLimit.js');
  return { signin, signout, createRateLimiter };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('FRONTEND_URL', FRONTEND);
  vi.stubEnv('TRUST_PROXY_IP_HEADER', '');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mockPrisma.user.findFirst.mockResolvedValue({
    id: 'u1', email: 'ana@example.com', passwordHash: '$scrypt$x', tenant: { id: 't1', name: 'T' },
  });
  mockAuth.verifyAndUpgrade.mockResolvedValue(false);
});

describe('createRateLimiter — 429 carries CORS headers, preflights never count (#78 D8)', () => {
  it('answers the 6th request with 429 RATE_LIMITED and ACAO for the allowed origin', async () => {
    const { createRateLimiter } = await freshModules();
    const limiter = createRateLimiter({ max: 5, windowMs: 60_000 });
    const handler = (req: any, res: any) => new Promise<void>((resolve) => limiter(req, res, () => { res.status(200).json({ ok: true }); resolve(); }));

    for (let i = 0; i < 5; i += 1) expect((await call(handler, makeReq())).statusCode).toBe(200);
    const res = await call(handler, makeReq());

    expect(res.statusCode).toBe(429);
    expect(res._body).toEqual({ error: 'Too Many Requests. Please try again later.', code: 'RATE_LIMITED' });
    expect(res._headers['access-control-allow-origin']).toBe(FRONTEND);
    expect(res._headers['access-control-allow-credentials']).toBe('true');
    expect(String(res._headers['access-control-expose-headers'])).toContain('RateLimit-Reset');
  });

  it('sets no ACAO on a 429 for a foreign origin', async () => {
    const { createRateLimiter } = await freshModules();
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });
    const handler = (req: any, res: any) => new Promise<void>((resolve) => limiter(req, res, () => { res.status(200).json({}); resolve(); }));
    const foreign = () => makeReq({ headers: { origin: 'https://evil.example' } });

    await call(handler, foreign());
    const res = await call(handler, foreign());

    expect(res.statusCode).toBe(429);
    expect(res._headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not count 10 OPTIONS preflights', async () => {
    const { createRateLimiter } = await freshModules();
    const limiter = createRateLimiter({ max: 2, windowMs: 60_000 });
    const handler = (req: any, res: any) => new Promise<void>((resolve) => limiter(req, res, () => { res.status(200).json({}); resolve(); }));

    for (let i = 0; i < 10; i += 1) await call(handler, makeReq({ method: 'OPTIONS' }));
    expect((await call(handler, makeReq())).statusCode).toBe(200);
    expect((await call(handler, makeReq())).statusCode).toBe(200);
    expect((await call(handler, makeReq())).statusCode).toBe(429);
  });
});

describe('POST /api/auth/signin', () => {
  it('rejects a cross-origin form POST with 403 UNTRUSTED_ORIGIN before any lookup (#78 R7)', async () => {
    const { signin } = await freshModules();
    const res = await call(signin, makeReq({ headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' } }));

    expect(res.statusCode).toBe(403);
    expect(res._body.code).toBe('UNTRUSTED_ORIGIN');
    expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('6 attempts from one socket with 6 different X-Real-IP values: the 6th is 429 (#78 R3)', async () => {
    const { signin } = await freshModules();
    const statuses: number[] = [];
    for (let i = 1; i <= 6; i += 1) {
      const res = await call(signin, makeReq({ headers: { 'x-real-ip': `10.0.0.${i}`, 'x-forwarded-for': `10.9.9.${i}` } }));
      statuses.push(res.statusCode);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it('11 failed attempts on one email from 11 different IPs: the 11th is 429 (#78 D3)', async () => {
    const { signin } = await freshModules();
    const statuses: number[] = [];
    for (let i = 1; i <= 11; i += 1) {
      const res = await call(signin, makeReq({ ip: `198.51.100.${i}`, body: { email: ' ANA@example.com ', password: 'nope' } }));
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(mockPrisma.user.findFirst).toHaveBeenCalledTimes(10);
  });

  it('successful sign-ins do not use up the per-account budget', async () => {
    mockAuth.verifyAndUpgrade.mockResolvedValue(true);
    const { signin } = await freshModules();
    const statuses: number[] = [];
    for (let i = 1; i <= 12; i += 1) {
      statuses.push((await call(signin, makeReq({ ip: `198.51.100.${i}`, body: { email: 'ana@example.com', password: 'right' } }))).statusCode);
    }
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it('a password-check failure is a 500 reported to Sentry, never "Invalid credentials" (#78 R9)', async () => {
    mockAuth.verifyAndUpgrade.mockRejectedValue(Object.assign(new Error('Cannot allocate memory'), { code: 'ERR_OUT_OF_MEMORY' }));
    const { signin } = await freshModules();

    const res = await call(signin, makeReq());

    expect(res.statusCode).toBe(500);
    expect(res._body.error).toBe('Authentication failed');
    expect(mockSentry.captureException).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/auth/signout', () => {
  it('has its own bucket: sign-outs never lock out sign-in (#78 R11)', async () => {
    const { signin, signout } = await freshModules();
    for (let i = 0; i < 10; i += 1) {
      expect((await call(signout, makeReq({ body: {} }))).statusCode).toBe(200);
    }
    expect((await call(signin, makeReq())).statusCode).toBe(401);
  });

  it('clears the NextAuth cookies under both names (#78 R2)', async () => {
    const { signout } = await freshModules();
    const res = await call(signout, makeReq({ body: {} }));

    const cookies = ([] as string[]).concat(res._headers['set-cookie'] as string[] ?? []);
    expect(cookies.some((c) => c.startsWith('next-auth.session-token=;') && c.includes('Max-Age=0'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('__Secure-next-auth.session-token=;') && c.includes('Secure'))).toBe(true);
  });
});
