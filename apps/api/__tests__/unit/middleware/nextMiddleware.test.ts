import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';

import { middleware, config } from '../../../middleware.js';

const TOKEN = 'bliss_AbCdEfGh_0123456789abcdefghijABCDEFGHIJklmnopqrstu';

function request(path: string, { method = 'GET', auth }: { method?: string; auth?: string } = {}) {
  const headers = new Headers();
  if (auth) headers.set('authorization', auth);
  return new NextRequest(new URL(path, 'https://api.bliss.test'), { method, headers });
}

async function body(res: Response) {
  return res.json();
}

describe('root middleware.js — integration denylist at the edge', () => {
  it('matches only API routes', () => {
    expect(config.matcher).toBe('/api/:path*');
  });

  it.each([
    ['POST', '/api/auth/signin'],
    ['GET', '/api/auth/session'],
    ['POST', '/api/auth/signout'],
    ['GET', '/api/auth/google-token'],
    ['GET', '/api/auth/callback/google'],
    ['DELETE', '/api/plaid/items/hard-delete'],
    ['PUT', '/api/users'],
    ['GET', '/api/integrations'],
    ['POST', '/api/accounts'],
  ])('%s %s with a bliss_ token → 403 NOT_AVAILABLE_TO_INTEGRATIONS', async (method, path) => {
    const res = middleware(request(path, { method, auth: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ code: 'NOT_AVAILABLE_TO_INTEGRATIONS' });
  });

  it('denies even a malformed bliss_ token on a denied route', async () => {
    const res = middleware(request('/api/auth/signin', { method: 'POST', auth: 'Bearer bliss_x' }));
    expect(res.status).toBe(403);
  });

  it.each([
    ['GET', '/api/transactions'],
    ['POST', '/api/transactions'],
    ['GET', '/api/accounts'],
    ['PUT', '/api/plaid/transactions/abc'],
  ])('%s %s with a bliss_ token passes through', (method, path) => {
    const res = middleware(request(path, { method, auth: `Bearer ${TOKEN}` }));
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('passes through session and JWT requests untouched', () => {
    expect(middleware(request('/api/auth/signin', { method: 'POST' })).headers.get('x-middleware-next')).toBe('1');
    expect(
      middleware(request('/api/users', { method: 'PUT', auth: 'Bearer eyJhbGciOiJIUzI1NiJ9.x.y' })).headers.get('x-middleware-next'),
    ).toBe('1');
  });
});
