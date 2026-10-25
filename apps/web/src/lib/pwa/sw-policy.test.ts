import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { pwaWorkboxOptions, NAVIGATE_FALLBACK_DENYLIST } from './sw-config';

const webRoot = path.resolve(__dirname, '../../..');

/**
 * The service worker is an app-shell cache only (PRD R3, AC2): nothing
 * fetched at runtime — above all no /api/* response — may reach Cache Storage.
 */
describe('service worker caching policy (#155)', () => {
  it('has no runtime caching at all', () => {
    expect(pwaWorkboxOptions.runtimeCaching).toEqual([]);
  });

  it('does not let the navigation fallback answer /api/* or /version.json', () => {
    const denied = (url: string) => NAVIGATE_FALLBACK_DENYLIST.some((re) => re.test(url));
    expect(denied('/api/transactions')).toBe(true);
    expect(denied('/api/auth/session')).toBe(true);
    expect(denied('/version.json')).toBe(true);
    expect(denied('/transactions')).toBe(false);
    expect(denied('/agents/review')).toBe(false);
    expect(pwaWorkboxOptions.navigateFallback).toBe('/index.html');
  });

  it('precaches only static shell files, never JSON, maps or templates', () => {
    expect(pwaWorkboxOptions.globPatterns.join(' ')).not.toMatch(/json\b|map\b|csv/);
    expect(pwaWorkboxOptions.globIgnores).toEqual(
      expect.arrayContaining(['**/*.map', 'version.json', 'templates/**']),
    );
  });

  it('never activates a new worker on its own and drops outdated precaches', () => {
    expect(pwaWorkboxOptions.skipWaiting).toBe(false);
    expect(pwaWorkboxOptions.cleanupOutdatedCaches).toBe(true);
  });

  it('is wired into vite.config.ts as a prompt-type, manually registered generateSW worker', () => {
    const config = readFileSync(path.resolve(webRoot, 'vite.config.ts'), 'utf8');
    expect(config).toContain('workbox: pwaWorkboxOptions');
    expect(config).toContain("registerType: 'prompt'");
    expect(config).toContain('injectRegister: false');
    expect(config).toContain("strategies: 'generateSW'");
  });

  it('index.html loads no third-party script', () => {
    const html = readFileSync(path.resolve(webRoot, 'index.html'), 'utf8');
    expect(html).not.toContain('gpteng.co');
    const scripts = html.match(/<script[^>]*src="([^"]+)"/g) ?? [];
    scripts.forEach((tag) => expect(tag).not.toMatch(/src="(https?:)?\/\//));
  });
});
