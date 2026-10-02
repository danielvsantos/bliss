import { describe, it, expect } from 'vitest';

import {
  INTEGRATION_DENYLIST,
  INTEGRATION_WRITE_ALLOWED,
  effectiveRole,
  extractIntegrationToken,
  isDeniedForIntegration,
  isIntegrationToken,
  isIntegrationWriteAllowed,
  normalizeApiPath,
  redactIntegrationTokens,
} from '../../../utils/integrationPolicy.js';

describe('normalizeApiPath', () => {
  it.each([
    ['/api/transactions', '/api/transactions'],
    ['/api/transactions?page=2&limit=10', '/api/transactions'],
    ['/api/transactions/', '/api/transactions'],
    ['/API/Users', '/api/users'],
    ['/api//users//', '/api/users'],
    ['/api/%75sers', '/api/users'],
    ['/api/transactions/../users', '/api/users'],
    ['/api/./users', '/api/users'],
    ['/api\\users', '/api/users'],
    ['https://bliss.example.com/api/users?x=1', '/api/users'],
    ['/api/transactions#frag', '/api/transactions'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeApiPath(input)).toBe(expected);
  });

  it('returns an empty string for a missing url', () => {
    expect(normalizeApiPath(undefined)).toBe('');
    expect(normalizeApiPath('')).toBe('');
    expect(normalizeApiPath(null)).toBe('');
  });

  it('keeps a malformed percent escape instead of throwing', () => {
    expect(normalizeApiPath('/api/%E0%A4%A')).toBe('/api/%e0%a4%a');
  });
});

describe('isDeniedForIntegration', () => {
  describe('ALL-method entries', () => {
    const allMethodPaths = INTEGRATION_DENYLIST.filter((e) => e.methods === 'ALL').map((e) => e.prefix);

    it.each(allMethodPaths)('%s is denied for GET and POST', (prefix) => {
      expect(isDeniedForIntegration(prefix, 'GET')).toBe(true);
      expect(isDeniedForIntegration(prefix, 'POST')).toBe(true);
      expect(isDeniedForIntegration(`${prefix}/`, 'DELETE')).toBe(true);
    });

    it.each([
      '/api/auth/session',
      '/api/auth/signin',
      '/api/auth/change-password',
      '/api/auth/google-token',
      '/api/users?id=abc',
      '/api/integrations/abc/keys/def',
      '/api/plaid/items/hard-delete',
    ])('%s is denied', (path) => {
      expect(isDeniedForIntegration(path, 'GET')).toBe(true);
    });
  });

  describe('NON_GET entries', () => {
    it.each(['/api/categories', '/api/tenants', '/api/tenants/settings', '/api/plaid/items'])(
      '%s allows GET/HEAD and denies writes',
      (path) => {
        expect(isDeniedForIntegration(path, 'GET')).toBe(false);
        expect(isDeniedForIntegration(path, 'HEAD')).toBe(false);
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
          expect(isDeniedForIntegration(path, method)).toBe(true);
        }
      },
    );
  });

  describe('INTEGRATION_WRITE_ALLOWED (#98)', () => {
    it('starts with exactly the account and bank creates', () => {
      expect(INTEGRATION_WRITE_ALLOWED).toEqual([
        { path: '/api/accounts', methods: ['POST'] },
        { path: '/api/banks', methods: ['POST'] },
      ]);
    });

    it('/api/accounts allows GET/HEAD and POST, denies every other write', () => {
      expect(isDeniedForIntegration('/api/accounts', 'GET')).toBe(false);
      expect(isDeniedForIntegration('/api/accounts', 'HEAD')).toBe(false);
      expect(isDeniedForIntegration('/api/accounts', 'POST')).toBe(false);
      for (const method of ['PUT', 'PATCH', 'DELETE']) {
        expect(isDeniedForIntegration('/api/accounts', method)).toBe(true);
        expect(isDeniedForIntegration('/api/accounts?id=1', method)).toBe(true);
      }
    });

    it('/api/banks POST is allowed', () => {
      expect(isDeniedForIntegration('/api/banks', 'POST')).toBe(false);
      expect(isIntegrationWriteAllowed('/api/banks', 'post')).toBe(true);
    });

    it.each(['/api/Accounts/', '/api//accounts', '/api/x/../accounts', '/api/%61ccounts', '/api/accounts?id=1', '/API/BANKS'])(
      '%s stays exact after normalisation: POST only',
      (path) => {
        expect(isDeniedForIntegration(path, 'POST')).toBe(false);
        if (path.toLowerCase().includes('ccounts')) {
          expect(isDeniedForIntegration(path, 'PUT')).toBe(true);
          expect(isDeniedForIntegration(path, 'DELETE')).toBe(true);
        }
      },
    );

    it.each([
      '/api/accounts/x',
      '/api/accounts/../categories',
      '/api/categories',
      '/api/tenants',
      '/api/tenants/settings',
      '/api/users',
      '/api/integrations',
      '/api/oauth/token',
    ])('POST %s is still denied', (path) => {
      expect(isDeniedForIntegration(path, 'POST')).toBe(true);
      expect(isIntegrationWriteAllowed(path, 'POST')).toBe(false);
    });

    it('never matches a prefix or another method', () => {
      expect(isIntegrationWriteAllowed('/api/accounts/1', 'POST')).toBe(false);
      expect(isIntegrationWriteAllowed('/api/banksx', 'POST')).toBe(false);
      expect(isIntegrationWriteAllowed('/api/accounts', 'PUT')).toBe(false);
      expect(isIntegrationWriteAllowed('/api/accounts', undefined as any)).toBe(false);
    });
  });

  it('matches on whole segments only', () => {
    expect(isDeniedForIntegration('/api/usersettings', 'GET')).toBe(false);
    expect(isDeniedForIntegration('/api/authors', 'GET')).toBe(false);
    expect(isDeniedForIntegration('/api/accountsx', 'POST')).toBe(false);
  });

  it('keeps the Plaid review queue available', () => {
    expect(isDeniedForIntegration('/api/plaid/transactions', 'GET')).toBe(false);
    expect(isDeniedForIntegration('/api/plaid/transactions/abc', 'PUT')).toBe(false);
    expect(isDeniedForIntegration('/api/plaid/transactions/bulk-promote', 'POST')).toBe(false);
    expect(isDeniedForIntegration('/api/plaid/transactions/abc/retry', 'POST')).toBe(false);
    expect(isDeniedForIntegration('/api/plaid/accounts', 'GET')).toBe(false);
    expect(isDeniedForIntegration('/api/plaid/sync-logs', 'GET')).toBe(false);
  });

  it('allows ordinary data routes', () => {
    expect(isDeniedForIntegration('/api/transactions', 'GET')).toBe(false);
    expect(isDeniedForIntegration('/api/transactions', 'POST')).toBe(false);
    expect(isDeniedForIntegration('/api/portfolio/holdings', 'GET')).toBe(false);
  });

  it('is not fooled by case, encoding or dot segments', () => {
    expect(isDeniedForIntegration('/API/USERS', 'GET')).toBe(true);
    expect(isDeniedForIntegration('/api/%75sers', 'GET')).toBe(true);
    expect(isDeniedForIntegration('/api/transactions/../integrations', 'GET')).toBe(true);
    expect(isDeniedForIntegration('/api/Accounts/', 'put')).toBe(true);
    expect(isDeniedForIntegration('/api/%61ccounts', 'DELETE')).toBe(true);
  });

  it('fails closed when the path is unknown', () => {
    expect(isDeniedForIntegration(undefined as any, 'GET')).toBe(true);
    expect(isDeniedForIntegration('', 'GET')).toBe(true);
    expect(isDeniedForIntegration('/', 'GET')).toBe(true);
  });
});

describe('effectiveRole', () => {
  it('READ_ONLY is always viewer', () => {
    expect(effectiveRole('admin', 'READ_ONLY')).toBe('viewer');
    expect(effectiveRole('member', 'READ_ONLY')).toBe('viewer');
  });

  it('READ_WRITE is member, never admin', () => {
    expect(effectiveRole('admin', 'READ_WRITE')).toBe('member');
    expect(effectiveRole('member', 'READ_WRITE')).toBe('member');
  });

  it('READ_WRITE drops to viewer when the creator was demoted to viewer', () => {
    expect(effectiveRole('viewer', 'READ_WRITE')).toBe('viewer');
  });

  it('unknown access levels are treated as read-only', () => {
    expect(effectiveRole('admin', 'SOMETHING' as any)).toBe('viewer');
  });
});

describe('extractIntegrationToken / isIntegrationToken', () => {
  it('extracts a bliss_ bearer token', () => {
    expect(extractIntegrationToken('Bearer bliss_abc_def')).toBe('bliss_abc_def');
    expect(extractIntegrationToken('bearer  bliss_abc_def')).toBe('bliss_abc_def');
    expect(isIntegrationToken('Bearer bliss_x')).toBe(true);
  });

  it('ignores JWTs, other schemes and missing headers', () => {
    expect(extractIntegrationToken('Bearer eyJhbGciOi.x.y')).toBeNull();
    expect(extractIntegrationToken('Basic bliss_abc')).toBeNull();
    expect(extractIntegrationToken(undefined)).toBeNull();
    expect(isIntegrationToken('')).toBe(false);
  });
});

describe('redactIntegrationTokens', () => {
  it('redacts tokens inside free text', () => {
    const token = `bliss_AbCdEfGh_${'x'.repeat(43)}`;
    expect(redactIntegrationTokens(`failed for ${token}!`)).toBe('failed for bliss_[redacted]!');
    expect(redactIntegrationTokens('nothing here')).toBe('nothing here');
    expect(redactIntegrationTokens(undefined)).toBe('');
  });
});
