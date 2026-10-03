/**
 * GET /api/auth/signup-mode — public flag for the SPA (#99). Returns only
 * `{ inviteOnly }`: no counts, emails or env details.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('../../../utils/cors.js', () => ({ cors: () => false }));

import handler from '../../../pages/api/auth/signup-mode.js';

function makeRes() {
  const res: any = { headers: {} as Record<string, unknown> };
  res.status = vi.fn((c: number) => { res._status = c; return res; });
  res.json = vi.fn((b: unknown) => { res._body = b; return res; });
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn((k: string, v: unknown) => { res.headers[k] = v; return res; });
  return res;
}

function call(method = 'GET') {
  const res = makeRes();
  handler({ method, headers: {}, query: {} } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res;
}

const saved = process.env.SIGNUP_MODE;
afterEach(() => {
  if (saved === undefined) delete process.env.SIGNUP_MODE;
  else process.env.SIGNUP_MODE = saved;
});

describe('GET /api/auth/signup-mode', () => {
  it.each([
    [undefined, false],
    ['open', false],
    ['invite_only', true],
    ['invite-only', true], // unknown value fails closed
  ])('SIGNUP_MODE=%s → { inviteOnly: %s } and nothing else', (mode, expected) => {
    if (mode === undefined) delete process.env.SIGNUP_MODE;
    else process.env.SIGNUP_MODE = mode;

    const res = call();

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ inviteOnly: expected });
    expect(Object.keys(res._body)).toEqual(['inviteOnly']);
  });

  it('is cacheable for a minute', () => {
    expect(call().headers['Cache-Control']).toBe('public, max-age=60');
  });

  it.each(['POST', 'PUT', 'DELETE'])('rejects %s with 405', (method) => {
    const res = call(method);
    expect(res._status).toBe(405);
    expect(res.headers.Allow).toEqual(['GET']);
  });
});
