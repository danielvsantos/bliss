import { describe, it, expect, vi, afterEach } from 'vitest';
import { clientIp, normalizeIp, _resetClientIpWarning } from '../../../utils/clientIp.js';
import { requestIp } from '../../../utils/apiKeys.js';
import { clientIp as loopbackClientIp } from '../../../lib/mcp/loopback.js';

function req(headers: Record<string, string>, remoteAddress?: string) {
  return { headers, socket: { remoteAddress } };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _resetClientIpWarning();
});

describe('clientIp (#78 R3)', () => {
  it('ignores a spoofed x-real-ip / x-forwarded-for when TRUST_PROXY_IP_HEADER is unset', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(clientIp(req({ 'x-real-ip': '10.0.0.1', 'x-forwarded-for': '10.0.0.2' }, '203.0.113.5'))).toBe('203.0.113.5');
  });

  it('warns once per process when a header is ignored', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    clientIp(req({ 'x-real-ip': '10.0.0.1' }, '203.0.113.5'));
    clientIp(req({ 'x-real-ip': '10.0.0.2' }, '203.0.113.5'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('trust_proxy_header_ignored');
  });

  it('honours x-real-ip with TRUST_PROXY_IP_HEADER=x-real-ip (Railway)', () => {
    vi.stubEnv('TRUST_PROXY_IP_HEADER', 'x-real-ip');
    expect(clientIp(req({ 'x-real-ip': '198.51.100.7' }, '10.1.2.3'))).toBe('198.51.100.7');
  });

  it('uses the RIGHTMOST x-forwarded-for entry with TRUST_PROXY_IP_HEADER=x-forwarded-for', () => {
    vi.stubEnv('TRUST_PROXY_IP_HEADER', 'X-Forwarded-For');
    expect(clientIp(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 198.51.100.9' }, '10.1.2.3'))).toBe('198.51.100.9');
  });

  it('falls back to the socket when the trusted header is absent', () => {
    vi.stubEnv('TRUST_PROXY_IP_HEADER', 'x-real-ip');
    expect(clientIp(req({}, '10.1.2.3'))).toBe('10.1.2.3');
  });

  it('ignores an unknown TRUST_PROXY_IP_HEADER value', () => {
    vi.stubEnv('TRUST_PROXY_IP_HEADER', 'cf-connecting-ip');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(clientIp(req({ 'cf-connecting-ip': '1.1.1.1', 'x-real-ip': '2.2.2.2' }, '203.0.113.5'))).toBe('203.0.113.5');
  });

  it('trusts x-real-ip from a loopback socket (MCP loopback calls)', () => {
    expect(clientIp(req({ 'x-real-ip': '198.51.100.7' }, '127.0.0.1'))).toBe('198.51.100.7');
    expect(clientIp(req({ 'x-real-ip': '198.51.100.8' }, '::1'))).toBe('198.51.100.8');
    expect(clientIp(req({ 'x-real-ip': '198.51.100.9' }, '::ffff:127.0.0.1'))).toBe('198.51.100.9');
    expect(clientIp(req({}, '127.0.0.1'))).toBe('127.0.0.1');
  });

  it('normalises IPv4-mapped IPv6 addresses', () => {
    expect(normalizeIp('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeIp('')).toBeNull();
    expect(clientIp(req({}, '::ffff:203.0.113.5'))).toBe('203.0.113.5');
  });

  it('returns null when nothing is known', () => {
    expect(clientIp({ headers: {} })).toBeNull();
  });

  it('requestIp and the MCP loopback forwarder use the same resolution', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = req({ 'x-real-ip': '10.0.0.1' }, '203.0.113.5');
    expect(requestIp(r)).toBe('203.0.113.5');
    expect(loopbackClientIp(r)).toBe('203.0.113.5');
    expect(loopbackClientIp({ headers: {} })).toBe('127.0.0.1');
  });
});
