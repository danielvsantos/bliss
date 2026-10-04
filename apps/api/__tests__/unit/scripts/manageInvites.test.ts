/**
 * scripts/manage-invites.mjs (#99) — operator CLI over /api/admin/invites.
 * fetch is injected, so these cover arg parsing, the HTTP contract and exit
 * codes without a server.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  parseArgs,
  buildRequest,
  resolveBaseUrl,
  formatInvites,
  run,
  UsageError,
} from '../../../scripts/manage-invites.mjs';

function jsonResponse(status: number, body?: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
  };
}

function harness(response: ReturnType<typeof jsonResponse>, env: Record<string, string | undefined> = { ADMIN_API_KEY: 'k' }) {
  const out: string[] = [];
  const err: string[] = [];
  const fetchImpl = vi.fn().mockResolvedValue(response);
  return {
    out,
    err,
    fetchImpl,
    exec: (argv: string[]) =>
      run(argv, { env, fetchImpl, out: (s: string) => out.push(s), err: (s: string) => err.push(s) }),
  };
}

describe('parseArgs', () => {
  it('parses add with a note', () => {
    expect(parseArgs(['add', 'ana@example.com', '--note', 'Ana – college'])).toEqual({
      command: 'add',
      email: 'ana@example.com',
      note: 'Ana – college',
      url: undefined,
    });
  });

  it('parses list filters and --url', () => {
    expect(parseArgs(['list', '--unused'])).toMatchObject({ command: 'list', status: 'unused' });
    expect(parseArgs(['list', '--used', '--url', 'https://api.x'])).toMatchObject({ status: 'used', url: 'https://api.x' });
  });

  it('parses revoke', () => {
    expect(parseArgs(['revoke', 'ana@example.com'])).toMatchObject({ command: 'revoke', email: 'ana@example.com' });
  });

  it.each([
    [[]],
    [['add']],
    [['revoke']],
    [['list', 'x@y.z']],
    [['list', '--used', '--unused']],
    [['frobnicate']],
    [['add', 'a@b.c', '--note']],
    [['add', 'a@b.c', '--bogus']],
    [['revoke', 'a@b.c', '--used']],
  ])('rejects %j with a UsageError', (argv) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
  });
});

describe('buildRequest / resolveBaseUrl', () => {
  const ctx = { baseUrl: 'https://api.example.com', adminKey: 'k' };

  it('POSTs add as JSON with the admin key', () => {
    expect(buildRequest({ command: 'add', email: 'a@b.co', note: 'n' }, ctx)).toEqual({
      method: 'POST',
      url: 'https://api.example.com/api/admin/invites',
      headers: { 'x-admin-key': 'k', accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.co', note: 'n' }),
    });
  });

  it('GETs list with the status filter', () => {
    expect(buildRequest({ command: 'list', status: 'used' }, ctx).url).toBe(
      'https://api.example.com/api/admin/invites?status=used',
    );
    expect(buildRequest({ command: 'list' }, ctx).url).toBe('https://api.example.com/api/admin/invites');
  });

  // A query string lands in platform access logs; the body does not.
  it('DELETEs revoke with the email in the JSON body, never in the URL', () => {
    const req = buildRequest({ command: 'revoke', email: 'a+b@c.co' }, ctx);
    expect(req.method).toBe('DELETE');
    expect(req.url).toBe('https://api.example.com/api/admin/invites');
    expect(req.body).toBe(JSON.stringify({ email: 'a+b@c.co' }));
    expect(req.headers['content-type']).toBe('application/json');
  });

  it('resolves the base URL: --url > BLISS_API_URL > NEXTAUTH_URL > localhost, trailing slash dropped', () => {
    expect(resolveBaseUrl({ url: 'https://x/' }, { BLISS_API_URL: 'https://y' })).toBe('https://x');
    expect(resolveBaseUrl({}, { BLISS_API_URL: 'https://y/', NEXTAUTH_URL: 'https://z' })).toBe('https://y');
    expect(resolveBaseUrl({}, { NEXTAUTH_URL: 'https://z' })).toBe('https://z');
    expect(resolveBaseUrl({}, {})).toBe('http://localhost:3000');
  });
});

describe('run', () => {
  it('exits 1 without ADMIN_API_KEY and makes no request', async () => {
    const h = harness(jsonResponse(200, { invites: [] }), {});
    expect(await h.exec(['list'])).toBe(1);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.err.join('\n')).toMatch(/ADMIN_API_KEY is not set/);
  });

  it('exits 1 with usage on a bad command', async () => {
    const h = harness(jsonResponse(200, {}));
    expect(await h.exec(['nope'])).toBe(1);
    expect(h.err.join('\n')).toMatch(/Usage:/);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('exits 1 on 401 with a clear message', async () => {
    const h = harness(jsonResponse(401, { error: 'Unauthorized' }));
    expect(await h.exec(['list'])).toBe(1);
    expect(h.err.join('\n')).toMatch(/401 Unauthorized/);
  });

  it('exits 1 on 409 and prints the code', async () => {
    const h = harness(jsonResponse(409, { error: 'An invite for this email already exists', code: 'INVITE_EXISTS' }));
    expect(await h.exec(['add', 'a@b.co'])).toBe(1);
    expect(h.err.join('\n')).toMatch(/409 .*INVITE_EXISTS/);
  });

  it('exits 1 when the API is unreachable', async () => {
    const h = harness(jsonResponse(200, {}));
    h.fetchImpl.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await h.exec(['list'])).toBe(1);
    expect(h.err.join('\n')).toMatch(/could not reach/);
  });

  it('add → 0 and confirms the stored (normalized) email', async () => {
    const h = harness(jsonResponse(201, { invite: { email: 'ana@example.com' } }));
    expect(await h.exec(['add', 'Ana@Example.com'])).toBe(0);
    expect(h.out.join('\n')).toBe('Invited ana@example.com.');
    const [url, init] = h.fetchImpl.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/admin/invites');
    expect(init.method).toBe('POST');
    expect(init.headers['x-admin-key']).toBe('k');
  });

  it('list → 0 and prints a table', async () => {
    const h = harness(
      jsonResponse(200, {
        invites: [
          { email: 'ana@example.com', note: 'Ana', createdAt: '2026-10-01T10:00:00Z', usedAt: null, usedByTenantId: null },
        ],
      }),
    );
    expect(await h.exec(['list', '--unused'])).toBe(0);
    expect(h.out[0]).toMatch(/EMAIL\s+STATUS/);
    expect(h.out[0]).toMatch(/ana@example\.com\s+unused/);
  });

  it('revoke → 0 on 204', async () => {
    const h = harness(jsonResponse(204));
    expect(await h.exec(['revoke', 'ana@example.com'])).toBe(0);
    expect(h.out.join('\n')).toMatch(/Revoked/);
  });
});

describe('formatInvites', () => {
  it('says so when empty', () => {
    expect(formatInvites([])).toBe('No invites.');
  });

  it('shows used invites with their tenant', () => {
    const text = formatInvites([
      { email: 'b@x.co', note: null, createdAt: '2026-10-01T10:00:00Z', usedAt: '2026-10-02T11:30:00Z', usedByTenantId: 't1' },
    ]);
    expect(text).toMatch(/b@x\.co\s+used\s+2026-10-01 10:00\s+2026-10-02 11:30\s+t1/);
    expect(text).toMatch(/1 invite\(s\)/);
  });
});
