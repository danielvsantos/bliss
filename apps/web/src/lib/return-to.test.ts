import { describe, it, expect, beforeEach } from 'vitest';
import { authPathFor, consumeReturnTo, rememberReturnTo, returnToFromLocation, safeReturnTo } from './return-to';

describe('safeReturnTo', () => {
  it.each(['/oauth/consent?request=abc', '/transactions', '/'])('accepts %s', (v) => {
    expect(safeReturnTo(v)).toBe(v);
  });

  it.each([
    '//evil.com', '/\\evil.com', 'https://evil.com', 'evil.com/x', 'javascript:alert(1)', '', '/auth', '/auth?returnTo=/x',
    '/x\n', null, undefined,
  ])('rejects %s', (v) => {
    expect(safeReturnTo(v as string)).toBeNull();
  });
});

describe('returnTo helpers', () => {
  beforeEach(() => sessionStorage.clear());

  it('reads returnTo from a query string', () => {
    expect(returnToFromLocation('?returnTo=%2Foauth%2Fconsent%3Frequest%3Dx')).toBe('/oauth/consent?request=x');
    expect(returnToFromLocation('?returnTo=%2F%2Fevil.com')).toBeNull();
  });

  it('builds the sign-in path', () => {
    expect(authPathFor('/oauth/consent?request=x')).toBe('/auth?returnTo=%2Foauth%2Fconsent%3Frequest%3Dx');
    expect(authPathFor('/')).toBe('/auth');
    expect(authPathFor('//evil.com')).toBe('/auth');
  });

  it('remembers returnTo across a full-page redirect exactly once', () => {
    rememberReturnTo('?returnTo=%2Foauth%2Fconsent%3Frequest%3Dx');
    expect(consumeReturnTo()).toBe('/oauth/consent?request=x');
    expect(consumeReturnTo()).toBeNull();
    rememberReturnTo('?returnTo=https%3A%2F%2Fevil.com');
    expect(consumeReturnTo()).toBeNull();
  });
});
