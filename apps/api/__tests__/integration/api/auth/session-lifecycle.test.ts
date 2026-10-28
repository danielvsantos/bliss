/**
 * Integration tests for the session lifecycle (#156): short access JWT +
 * rotating refresh token, revocation and the recent sign-in rule.
 *
 * Real bliss_test Postgres via Prisma; rate limiters mocked. Each "device"
 * keeps its own cookie jar, filled from the handlers' Set-Cookie headers, so
 * the flows run exactly like a browser would drive them. Time is moved with
 * fake `Date` only (Prisma's own timers stay real).
 *
 * Requires: bliss_test Postgres database with migrations applied.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('../../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
  createRateLimiter: vi.fn().mockReturnValue(
    (_req: unknown, _res: unknown, next: () => void) => next(),
  ),
}));

import prisma from '../../../../prisma/prisma.js';
import { AuthService } from '../../../../services/auth.service.js';
import { createIsolatedTenant, teardownTenant } from '../../../helpers/tenant.js';
import signinHandler from '../../../../pages/api/auth/signin.js';
import signoutHandler from '../../../../pages/api/auth/signout.js';
import refreshHandler from '../../../../pages/api/auth/refresh.js';
import sessionHandler from '../../../../pages/api/auth/session.js';
import reauthHandler from '../../../../pages/api/auth/reauth.js';
import changePasswordHandler from '../../../../pages/api/auth/change-password.js';
import revokeOthersHandler from '../../../../pages/api/auth/sessions/revoke-others.js';
import integrationsHandler from '../../../../pages/api/integrations/index.js';

const ORIGIN = 'http://localhost:8080';
const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = 'correct-horse-1';

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;

interface Response {
  status: number | undefined;
  body: any;
  setCookies: string[];
}

class Device {
  jar: Record<string, string> = {};
  constructor(public ua: string, public ip = '203.0.113.7') {}

  async call(handler: Handler, { method = 'POST', body = {}, url = '/api/auth/x', origin = ORIGIN } = {}): Promise<Response> {
    const headers: Record<string, string> = { 'user-agent': this.ua, 'x-real-ip': this.ip };
    if (origin) headers.origin = origin;
    const req = { method, url, headers, cookies: { ...this.jar }, body, query: {} } as unknown as NextApiRequest;
    const out: Response = { status: undefined, body: undefined, setCookies: [] };
    const headerStore: Record<string, unknown> = {};
    const res: any = {
      status: (code: number) => { out.status = code; return res; },
      json: (b: unknown) => { out.body = b; return res; },
      end: () => res,
      setHeader: (k: string, v: unknown) => { headerStore[k] = v; return res; },
      getHeader: (k: string) => headerStore[k],
      redirect: () => res,
    };
    await handler(req, res as NextApiResponse);
    const raw = headerStore['Set-Cookie'];
    out.setCookies = raw === undefined ? [] : (Array.isArray(raw) ? raw : [String(raw)]);
    for (const cookie of out.setCookies) {
      const [pair, ...attrs] = cookie.split('; ');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (attrs.includes('Max-Age=0') || value === '') delete this.jar[name];
      else this.jar[name] = value;
    }
    return out;
  }

  signin(email: string, password = PASSWORD) {
    return this.call(signinHandler, { body: { email, password } });
  }
  refresh(opts: { origin?: string } = {}) {
    return this.call(refreshHandler, opts);
  }
  session() {
    return this.call(sessionHandler, { method: 'GET', url: '/api/auth/session' });
  }
  sessionId() {
    return this.jar.bliss_rt?.split('.')[0];
  }
}

let tenantA: { tenantId: string; userId: string };
let tenantB: { tenantId: string; userId: string };
let emailA: string;
let emailB: string;

async function setPassword(userId: string) {
  const { hash, salt } = await AuthService.hashPassword(PASSWORD);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: hash, passwordSalt: salt } });
}

beforeAll(async () => {
  tenantA = await createIsolatedTenant('session-a');
  tenantB = await createIsolatedTenant('session-b');
  await setPassword(tenantA.userId);
  await setPassword(tenantB.userId);
  emailA = (await prisma.user.findUnique({ where: { id: tenantA.userId } }))!.email;
  emailB = (await prisma.user.findUnique({ where: { id: tenantB.userId } }))!.email;
}, 60_000);

afterAll(async () => {
  vi.useRealTimers();
  await teardownTenant(tenantA.tenantId);
  await teardownTenant(tenantB.tenantId);
});

afterEach(async () => {
  vi.useRealTimers();
  await prisma.user.updateMany({
    where: { id: { in: [tenantA.userId, tenantB.userId] } },
    data: { sessionsRevokedAt: null },
  });
  await prisma.userSession.deleteMany({ where: { tenantId: { in: [tenantA.tenantId, tenantB.tenantId] } } });
});

function useClock(start: Date) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start);
  return (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
}

describe('sign-in issues both cookies (AC4)', () => {
  it('sets a 15-min access cookie and a path-scoped refresh cookie; stores only the hash', async () => {
    const device = new Device(UA_MAC);
    const res = await device.signin(emailA);

    expect(res.status).toBe(200);
    const access = res.setCookies.find((c) => c.startsWith('token='))!;
    const refresh = res.setCookies.find((c) => c.startsWith('bliss_rt='))!;
    expect(access).toContain('Max-Age=900');
    expect(access).toContain('Path=/;');
    expect(refresh).toContain('HttpOnly');
    expect(refresh).toContain('Path=/api/auth');
    expect(refresh).toContain(`Max-Age=${7 * 24 * 60 * 60}`);
    expect(refresh.includes('SameSite=Lax')).toBe(access.includes('SameSite=Lax'));

    const [sessionId, secret] = device.jar.bliss_rt.split('.');
    const row = await prisma.userSession.findFirst({ where: { id: sessionId, tenantId: tenantA.tenantId } });
    expect(row!.tokenHash).toBe(crypto.createHash('sha256').update(secret).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(secret);

    const claims = jwt.decode(device.jar.token) as Record<string, number>;
    expect(claims.exp - claims.iat).toBe(900);
    expect(typeof claims.auth_time).toBe('number');
  });
});

describe('lifetimes (AC1–AC3, AC5)', () => {
  it('keeps an active user signed in for 14 days, refreshing weekly', async () => {
    const advance = useClock(new Date('2026-11-01T09:00:00Z'));
    const device = new Device(UA_IPHONE);
    await device.signin(emailA);
    const created = await prisma.userSession.findFirst({ where: { id: device.sessionId(), tenantId: tenantA.tenantId } });

    for (let day = 6; day <= 12; day += 6) {
      advance(6 * DAY);
      expect((await device.refresh()).status).toBe(200);
    }
    advance(2 * DAY); // day 14
    expect((await device.refresh()).status).toBe(200);
    expect((await device.session()).status).toBe(200);

    const row = await prisma.userSession.findFirst({ where: { id: device.sessionId(), tenantId: tenantA.tenantId } });
    expect(row!.authenticatedAt).toEqual(created!.authenticatedAt);
    expect(row!.absoluteExpiresAt).toEqual(created!.absoluteExpiresAt);
    expect(row!.previousTokenHash).not.toBeNull();
    // Idle reset is capped at the absolute expiry (day 14 + 7 > day 15).
    expect(row!.idleExpiresAt).toEqual(created!.absoluteExpiresAt);
  });

  it('ends the session at the 15-day cap however active the user is', async () => {
    const advance = useClock(new Date('2026-11-01T09:00:00Z'));
    const device = new Device(UA_IPHONE);
    await device.signin(emailA);
    for (let i = 0; i < 3; i++) {
      advance(5 * DAY);
      if (i < 2) expect((await device.refresh()).status).toBe(200);
    }
    advance(60_000); // day 15 + 1 min

    const res = await device.refresh();
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_EXPIRED');
    expect(device.jar.token).toBeUndefined();
    expect(device.jar.bliss_rt).toBeUndefined();
  });

  it('ends a session unused for more than 7 days', async () => {
    const advance = useClock(new Date('2026-11-01T09:00:00Z'));
    const device = new Device(UA_MAC);
    await device.signin(emailA);
    advance(7 * DAY + 60_000);

    const res = await device.refresh();
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_EXPIRED');
  });
});

describe('rotation, grace and reuse (AC6, AC7)', () => {
  it('revokes the whole family when a rotated token is replayed from another device', async () => {
    const advance = useClock(new Date('2026-11-01T09:00:00Z'));
    const victim = new Device(UA_MAC);
    await victim.signin(emailA);
    const stolen = victim.jar.bliss_rt;
    advance(60_000);
    expect((await victim.refresh()).status).toBe(200);

    advance(11_000);
    const attacker = new Device(UA_WIN, '198.51.100.9');
    attacker.jar.bliss_rt = stolen;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await attacker.refresh();
    const logged = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_REVOKED');
    expect(attacker.jar.bliss_rt).toBeUndefined();
    const row = await prisma.userSession.findFirst({ where: { id: victim.sessionId(), tenantId: tenantA.tenantId } });
    expect(row!.revokedReason).toBe('reuse');
    // The victim's current token is dead too: the family is revoked.
    expect((await victim.refresh()).status).toBe(401);

    const reuse = logged.find((l) => l.includes('refresh_token_reuse'))!;
    expect(JSON.parse(reuse)).toEqual({
      event: 'refresh_token_reuse',
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      sessionId: row!.id,
    });
    expect(reuse).not.toContain(stolen.split('.')[1]);
  });

  it('treats a token two rotations old as reuse, even from the same device', async () => {
    const advance = useClock(new Date('2026-11-01T09:00:00Z'));
    const device = new Device(UA_MAC);
    await device.signin(emailA);
    const t1 = device.jar.bliss_rt;
    advance(60_000);
    await device.refresh();
    advance(60_000);
    await device.refresh();

    const replay = new Device(UA_MAC);
    replay.jar.bliss_rt = t1;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await replay.refresh()).status).toBe(401);
    vi.mocked(console.warn).mockRestore();
  });

  it('lets two tabs refresh with the same token at once (one rotation, no sign-out)', async () => {
    const device = new Device(UA_MAC);
    await device.signin(emailA);
    const tabB = new Device(UA_MAC);
    tabB.jar = { ...device.jar };

    const [a, b] = await Promise.all([device.refresh(), tabB.refresh()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const rows = await prisma.userSession.findMany({ where: { tenantId: tenantA.tenantId, userId: tenantA.userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].revokedAt).toBeNull();
    // Exactly one of the two received a new refresh cookie.
    expect([a, b].filter((r) => r.setCookies.some((c) => c.startsWith('bliss_rt='))).length).toBe(1);
  });

  it('recovers from a lost refresh response instead of flagging reuse', async () => {
    const advance = useClock(new Date('2026-11-01T09:00:00Z'));
    const device = new Device(UA_IPHONE);
    await device.signin(emailA);
    const t1 = device.jar.bliss_rt;
    advance(60_000);
    await device.refresh(); // response "lost": restore the old cookie
    device.jar.bliss_rt = t1;

    advance(30_000);
    const res = await device.refresh();
    expect(res.status).toBe(200);
    expect(device.jar.bliss_rt).not.toBe(t1);
    expect((await device.refresh()).status).toBe(200);
  });
});

describe('Origin guard (AC8)', () => {
  it('refuses a refresh from a foreign origin and changes nothing', async () => {
    const device = new Device(UA_MAC);
    await device.signin(emailA);
    const before = await prisma.userSession.findFirst({ where: { id: device.sessionId(), tenantId: tenantA.tenantId } });

    const res = await device.refresh({ origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('UNTRUSTED_ORIGIN');
    expect(res.setCookies).toEqual([]);
    const after = await prisma.userSession.findFirst({ where: { id: device.sessionId(), tenantId: tenantA.tenantId } });
    expect(after).toEqual(before);
  });

  it('refuses sign-out-others with neither Origin nor Referer', async () => {
    const device = new Device(UA_MAC);
    await device.signin(emailA);
    const res = await device.call(revokeOthersHandler, { origin: '' });
    expect(res.status).toBe(403);
  });
});

describe('revocation (AC9, R14)', () => {
  it('password change keeps this device and ends every other one on its next request', async () => {
    const a = new Device(UA_MAC);
    const b = new Device(UA_IPHONE);
    const c = new Device(UA_WIN);
    await a.signin(emailA);
    await b.signin(emailA);
    await c.signin(emailA);

    const res = await a.call(changePasswordHandler, {
      method: 'PUT',
      body: { currentPassword: PASSWORD, newPassword: PASSWORD, confirmPassword: PASSWORD },
    });
    expect(res.status).toBe(200);

    expect((await a.session()).status).toBe(200);
    expect((await a.refresh()).status).toBe(200);
    expect((await b.session()).status).toBe(401);
    expect((await c.session()).status).toBe(401);
    expect((await b.refresh()).status).toBe(401);
  });

  it('"Sign out of all other devices" keeps this device signed in', async () => {
    const a = new Device(UA_MAC);
    const b = new Device(UA_IPHONE);
    await a.signin(emailA);
    await b.signin(emailA);

    const res = await a.call(revokeOthersHandler);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: 1 });

    expect((await a.session()).status).toBe(200);
    expect((await a.refresh()).status).toBe(200);
    expect((await b.session()).status).toBe(401);
    expect((await b.refresh()).status).toBe(401);
  });

  it('signout revokes the family and clears both cookies', async () => {
    const device = new Device(UA_MAC);
    await device.signin(emailA);
    const sessionId = device.sessionId();
    const saved = device.jar.bliss_rt;

    const res = await device.call(signoutHandler);
    expect(res.status).toBe(200);
    expect(device.jar).toEqual({});
    const row = await prisma.userSession.findFirst({ where: { id: sessionId, tenantId: tenantA.tenantId } });
    expect(row!.revokedReason).toBe('signout');

    device.jar.bliss_rt = saved;
    expect((await device.refresh()).status).toBe(401);
  });
});

describe('recent sign-in (AC10, AC11)', () => {
  const create = (device: Device) => device.call(integrationsHandler, {
    url: '/api/integrations',
    body: { name: `Agent ${Date.now()}`, accessLevel: 'READ_ONLY', key: { expiresInDays: 30 } },
  });

  it('allows creating an integration right after sign-in', async () => {
    const device = new Device(UA_MAC);
    await device.signin(emailA);
    expect((await create(device)).status).toBe(201);
  });

  it('asks for the password after 15 minutes, keeps the session on a wrong one, then completes', async () => {
    const advance = useClock(new Date());
    const device = new Device(UA_MAC);
    await device.signin(emailA);
    advance(16 * 60 * 1000);
    expect((await device.refresh()).status).toBe(200); // auth_time is carried, not reset

    const blocked = await create(device);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('REAUTH_REQUIRED');

    const status = await device.call(reauthHandler, { method: 'GET', url: '/api/auth/reauth' });
    expect(status.body).toEqual({ recent: false, methods: ['password'] });

    const before = await prisma.userSession.findFirst({ where: { id: device.sessionId(), tenantId: tenantA.tenantId } });
    const wrong = await device.call(reauthHandler, { url: '/api/auth/reauth', body: { password: 'nope-nope' } });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('REAUTH_FAILED');
    expect(wrong.setCookies).toEqual([]);
    expect(await prisma.userSession.findFirst({ where: { id: device.sessionId(), tenantId: tenantA.tenantId } })).toEqual(before);

    const right = await device.call(reauthHandler, { url: '/api/auth/reauth', body: { password: PASSWORD } });
    expect(right.status).toBe(200);
    expect((await create(device)).status).toBe(201);

    const after = await prisma.userSession.findFirst({ where: { id: device.sessionId(), tenantId: tenantA.tenantId } });
    expect(after!.authenticatedAt.getTime()).toBeGreaterThan(before!.authenticatedAt.getTime());
    expect(after!.absoluteExpiresAt).toEqual(before!.absoluteExpiresAt);
  });

  it('treats a legacy 24h token (no auth_time) as not recent, but still signed in (AC15)', async () => {
    const legacy = jwt.sign(
      { jti: crypto.randomUUID(), userId: tenantA.userId, tenantId: tenantA.tenantId, email: emailA },
      process.env.JWT_SECRET_CURRENT as string,
      { expiresIn: '24h' },
    );
    const device = new Device(UA_MAC);
    device.jar.token = legacy;

    expect((await device.session()).status).toBe(200);
    expect((await create(device)).body.code).toBe('REAUTH_REQUIRED');

    // No refresh cookie: refresh is a clean 401 with no DB side effects.
    const res = await new Device(UA_MAC).refresh();
    expect(res.status).toBe(401);
    expect(await prisma.userSession.count({ where: { tenantId: tenantA.tenantId } })).toBe(0);

    // The password step-up starts a real session for the legacy device.
    const right = await device.call(reauthHandler, { url: '/api/auth/reauth', body: { password: PASSWORD } });
    expect(right.status).toBe(200);
    expect(device.jar.bliss_rt).toBeDefined();
    expect((await create(device)).status).toBe(201);
  });
});

describe('device data is encrypted (AC12)', () => {
  it('stores user agent and IP as ciphertext', async () => {
    const device = new Device(UA_IPHONE, '192.0.2.44');
    await device.signin(emailA);

    const [raw] = await prisma.$queryRaw<{ userAgent: string; ipAddress: string }[]>`
      SELECT "userAgent", "ipAddress" FROM "UserSession" WHERE "id" = ${device.sessionId()}`;
    expect(raw.userAgent).not.toContain('iOS');
    expect(raw.ipAddress).not.toContain('192.0.2.44');

    const row = await prisma.userSession.findFirst({ where: { id: device.sessionId(), tenantId: tenantA.tenantId } });
    expect(row!.userAgent).toBe('Safari on iOS');
    expect(row!.ipAddress).toBe('192.0.2.44');
  });
});

describe('tenant isolation (AC14)', () => {
  it("never reads or revokes another tenant's sessions", async () => {
    const a = new Device(UA_MAC);
    const b = new Device(UA_MAC);
    await a.signin(emailA);
    await b.signin(emailB);
    const bRowBefore = await prisma.userSession.findFirst({ where: { id: b.sessionId(), tenantId: tenantB.tenantId } });

    // A's sign-out-everywhere leaves tenant B alone.
    expect((await a.call(revokeOthersHandler)).status).toBe(200);
    const bUser = await prisma.user.findUnique({ where: { id: tenantB.userId } });
    expect(bUser!.sessionsRevokedAt).toBeNull();
    expect(await prisma.userSession.findFirst({ where: { id: b.sessionId(), tenantId: tenantB.tenantId } })).toEqual(bRowBefore);
    expect((await b.refresh()).status).toBe(200);

    // A cookie naming B's session id with A's secret is refused. Only a holder
    // of a B token can know B's id, so it is handled as a stolen B token
    // (D1): B's own family is revoked; tenant A's rows are never touched.
    const forged = new Device(UA_MAC);
    forged.jar.bliss_rt = `${b.sessionId()}.${a.jar.bliss_rt.split('.')[1]}`;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await forged.refresh()).status).toBe(401);
    vi.mocked(console.warn).mockRestore();
    const aRow = await prisma.userSession.findFirst({ where: { id: a.sessionId(), tenantId: tenantA.tenantId } });
    expect(aRow!.revokedAt).toBeNull();
    expect((await a.refresh()).status).toBe(200);
  });
});
