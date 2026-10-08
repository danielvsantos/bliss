/**
 * Unit tests — OAuth helpers for the MCP server (#89): configuration,
 * redirect-URI policy, PKCE, scopes, resource indicators, secret formats and
 * redaction of OAuth secrets.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import {
  allowedRedirectHosts, defaultClientName, issuerUrl, mcpChallenge, mcpResourceUrl, newAuthorizationCode, newRefreshToken,
  newRequestId, protectedResourceMetadataUrl, redirectUriError, requestedAccessFromScope, resourceIsValid,
  scopeForAccess, verifyPkce, withParams, frontendUrl,
} from '../../../utils/oauth.js';
import { redactIntegrationTokens, isDeniedForIntegration } from '../../../utils/integrationPolicy.js';
import { scrubEvent } from '../../../utils/sentryScrub.js';
import { OAUTH_REWRITES } from '../../../lib/oauthRewrites.js';
import { basicClientId, formBody } from '../../../lib/oauthHttp.js';

const ENV = ['OAUTH_ISSUER_URL', 'NEXTAUTH_URL', 'OAUTH_ALLOWED_REDIRECT_HOSTS', 'FRONTEND_URL'];
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]])); ENV.forEach((k) => delete process.env[k]); });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('configuration', () => {
  it('issuer: OAUTH_ISSUER_URL, else NEXTAUTH_URL origin, else localhost', () => {
    expect(issuerUrl()).toBe('http://localhost:3000');
    process.env.NEXTAUTH_URL = 'https://api.bliss.test/some/path';
    expect(issuerUrl()).toBe('https://api.bliss.test');
    process.env.OAUTH_ISSUER_URL = 'https://auth.bliss.test/';
    expect(issuerUrl()).toBe('https://auth.bliss.test');
    expect(mcpResourceUrl()).toBe('https://auth.bliss.test/api/mcp');
    expect(protectedResourceMetadataUrl()).toBe('https://auth.bliss.test/.well-known/oauth-protected-resource/api/mcp');
  });

  it('challenge header', () => {
    process.env.OAUTH_ISSUER_URL = 'https://api.bliss.test';
    expect(mcpChallenge()).toBe('Bearer resource_metadata="https://api.bliss.test/.well-known/oauth-protected-resource/api/mcp"');
    expect(mcpChallenge({ invalidToken: true })).toMatch(/, error="invalid_token"$/);
  });

  it('frontend URL and redirect-host allowlist', () => {
    expect(frontendUrl()).toBe('http://localhost:8080');
    process.env.FRONTEND_URL = 'https://app.bliss.test/';
    expect(frontendUrl()).toBe('https://app.bliss.test');
    expect([...allowedRedirectHosts()]).toEqual(['claude.ai', 'claude.com', 'oauth-redirect.googleusercontent.com', 'oauth-redirect-sandbox.googleusercontent.com', 'oauth-redirect-test.googleusercontent.com', 'localhost', '127.0.0.1']);
    process.env.OAUTH_ALLOWED_REDIRECT_HOSTS = ' Claude.ai , example.org ';
    expect([...allowedRedirectHosts()]).toEqual(['claude.ai', 'example.org']);
  });

  it('rewrites cover root and path-insertion discovery URLs', () => {
    expect(OAUTH_REWRITES.map((r) => r.source)).toEqual(expect.arrayContaining([
      '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/:path*',
      '/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/:path*',
    ]));
  });
});

describe('redirect-URI policy', () => {
  it.each([
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
    'http://localhost:33418/callback',
    'http://127.0.0.1/cb',
    'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-abc123-bliss.test',
    'https://oauth-redirect-sandbox.googleusercontent.com/r/user_bound_custom-mcp-abc123-bliss.test',
    'https://oauth-redirect-test.googleusercontent.com/r/user_bound_custom-mcp-abc123-bliss.test',
  ])('accepts %s', (uri) => expect(redirectUriError(uri)).toBeNull());

  it.each([
    ['https://evil.example/cb', /not allowed/],
    ['https://claude.ai.evil.example/cb', /not allowed/],
    ['https://evil.googleusercontent.com/cb', /not allowed/],
    ['https://script.googleusercontent.com/macros/echo', /not allowed/],
    ['https://oauth-redirect-evil.googleusercontent.com/cb', /not allowed/],
    ['http://claude.ai/cb', /only allowed for localhost/],
    ['https://claude.ai/cb#frag', /fragment/],
    ['https://user:pw@claude.ai/cb', /credentials/],
    ['javascript:alert(1)', /https/],
    ['com.example.app:/cb', /https/],
    ['not a url', /absolute URL/],
    ['', /must be a URL/],
  ])('rejects %s', (uri, why) => expect(redirectUriError(uri)).toMatch(why));

  it('loopback follows the allowlist as a group', () => {
    process.env.OAUTH_ALLOWED_REDIRECT_HOSTS = 'claude.ai';
    expect(redirectUriError('http://localhost:1/cb')).toMatch(/not allowed/);
    expect(redirectUriError('https://claude.ai/cb')).toBeNull();
  });
});

describe('client identity', () => {
  it('names a nameless client Gemini only when every redirect is Gemini\'s', () => {
    expect(defaultClientName(['https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-x'])).toBe('Gemini');
    expect(defaultClientName(['https://OAUTH-REDIRECT.googleusercontent.com/r/a', 'https://oauth-redirect.googleusercontent.com/r/b'])).toBe('Gemini');
    expect(defaultClientName(['https://oauth-redirect-sandbox.googleusercontent.com/r/user_bound_custom-mcp-x'])).toBe('Gemini');
    expect(defaultClientName([
      'https://oauth-redirect.googleusercontent.com/r/a', 'https://oauth-redirect-sandbox.googleusercontent.com/r/b',
      'https://oauth-redirect-test.googleusercontent.com/r/c',
    ])).toBe('Gemini');
    expect(defaultClientName(['https://oauth-redirect.googleusercontent.com/r/a', 'https://claude.ai/cb'])).toBe('MCP client');
    expect(defaultClientName(['https://claude.ai/cb'])).toBe('MCP client');
    expect(defaultClientName([])).toBe('MCP client');
  });

  it('reads client_id from HTTP Basic, ignoring the secret', () => {
    const basic = (s: string) => `Basic ${Buffer.from(s).toString('base64')}`;
    expect(basicClientId(basic('abc:secret'))).toBe('abc');
    expect(basicClientId(basic('abc:'))).toBe('abc');
    expect(basicClientId(basic('a%3Ab:x'))).toBe('a:b');
    expect(basicClientId(basic(':secret'))).toBeNull();
    expect(basicClientId('Bearer abc')).toBeNull();
    expect(basicClientId(undefined)).toBeNull();
    expect(basicClientId(basic('%E0%A4%A:x'))).toBeNull();
  });

  it('formBody: the body client_id wins over the header', () => {
    const authorization = `Basic ${Buffer.from('from-header:').toString('base64')}`;
    expect(formBody({ body: 'grant_type=x', headers: { authorization } } as any)).toEqual({ grant_type: 'x', client_id: 'from-header' });
    expect(formBody({ body: { client_id: 'from-body' }, headers: { authorization } } as any)).toEqual({ client_id: 'from-body' });
    expect(formBody({ headers: {} } as any)).toEqual({});
  });
});

describe('PKCE, scopes and resource', () => {
  it('verifies S256 only for well-formed pairs', () => {
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce(`${verifier}x`, challenge)).toBe(false);
    expect(verifyPkce('short', challenge)).toBe(false);
    expect(verifyPkce(verifier, 'x')).toBe(false);
    expect(verifyPkce(undefined as any, challenge)).toBe(false);
  });

  it('maps scope to the maximum grantable access', () => {
    expect(requestedAccessFromScope(undefined)).toBe('READ_WRITE');
    expect(requestedAccessFromScope('mcp:read')).toBe('READ_ONLY');
    expect(requestedAccessFromScope('mcp:read mcp:write')).toBe('READ_WRITE');
    expect(requestedAccessFromScope('openid profile')).toBe('READ_ONLY');
    expect(scopeForAccess('READ_ONLY')).toBe('mcp:read');
    expect(scopeForAccess('READ_WRITE')).toBe('mcp:read mcp:write');
  });

  it('accepts only this server\'s /api/mcp as resource', () => {
    process.env.OAUTH_ISSUER_URL = 'https://api.bliss.test';
    expect(resourceIsValid(undefined)).toBe(true);
    expect(resourceIsValid('https://api.bliss.test/api/mcp')).toBe(true);
    expect(resourceIsValid('https://api.bliss.test/api/mcp/')).toBe(true);
    expect(resourceIsValid('https://other.test/api/mcp')).toBe(false);
  });
});

describe('secrets and redaction', () => {
  it('generates unguessable ids, codes and refresh tokens', () => {
    expect(newRequestId()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newAuthorizationCode()).not.toBe(newAuthorizationCode());
    expect(newRefreshToken()).toMatch(/^bliss_rt_[A-Za-z0-9]{48}$/);
  });

  it('withParams keeps the redirect URI\'s own query and skips empty values', () => {
    expect(withParams('https://claude.ai/cb?x=1', { code: 'c', state: undefined, iss: 'https://a' }))
      .toBe('https://claude.ai/cb?x=1&code=c&iss=https%3A%2F%2Fa');
  });

  it('redacts refresh tokens in logs and Sentry events', () => {
    const rt = newRefreshToken();
    expect(redactIntegrationTokens(`failed for ${rt}`)).toBe('failed for bliss_[redacted]');
    const event = scrubEvent({
      message: `oops ${rt}`,
      extra: { refresh_token: rt, code_verifier: 'v', nested: { client_secret: 's' } },
      request: { url: '/api/oauth/token?code=abc', method: 'POST', data: 'refresh_token=x' },
    } as any) as any;
    const json = JSON.stringify(event);
    expect(json).not.toContain(rt);
    expect(json).not.toContain('code=abc');
    expect(event.extra.refresh_token).not.toBe(rt);
  });

  it('integration keys are denied on every /api/oauth route', () => {
    for (const path of ['/api/oauth/token', '/api/oauth/requests/x/approve', '/api/OAuth/register']) {
      expect(isDeniedForIntegration(path, 'POST')).toBe(true);
      expect(isDeniedForIntegration(path, 'GET')).toBe(true);
    }
  });
});
