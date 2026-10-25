import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { pwaManifest, PWA_THEME_COLOR, PWA_BACKGROUND_COLOR } from './manifest';

const webRoot = path.resolve(__dirname, '../../..');
const css = readFileSync(path.resolve(webRoot, 'src/index.css'), 'utf8');

/** First `--token: H S% L%;` declaration (the light theme) as [r, g, b]. */
function tokenRgb(token: string): [number, number, number] {
  const match = css.match(new RegExp(`--${token}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`));
  if (!match) throw new Error(`--${token} not found in index.css`);
  const [h, s, l] = [Number(match[1]) / 360, Number(match[2]) / 100, Number(match[3]) / 100];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    const tt = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)].map((c) => Math.round(c * 255)) as [number, number, number];
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

describe('PWA manifest (#155)', () => {
  it('is an installable standalone app rooted at /', () => {
    expect(pwaManifest).toMatchObject({
      id: '/',
      name: 'Bliss',
      short_name: 'Bliss',
      start_url: '/',
      scope: '/',
      display: 'standalone',
    });
  });

  // index.css stores tokens as rounded HSL, so allow the rounding error only.
  it.each([
    ['brand-deep', PWA_THEME_COLOR],
    ['brand-primary', PWA_BACKGROUND_COLOR],
  ])('colour matches the --%s token', (token, hex) => {
    const fromToken = tokenRgb(token);
    hexRgb(hex).forEach((value, i) => expect(Math.abs(value - fromToken[i])).toBeLessThanOrEqual(3));
  });

  it('theme-color meta tags in index.html use the manifest theme colour', () => {
    const html = readFileSync(path.resolve(webRoot, 'index.html'), 'utf8');
    const metas = html.match(/<meta name="theme-color" content="([^"]+)"/g) ?? [];
    expect(metas).toHaveLength(2);
    metas.forEach((meta) => expect(meta).toContain(PWA_THEME_COLOR));
  });

  it('has 192, 512 and maskable 512 icons that exist in public/', () => {
    const bySize = pwaManifest.icons.map((icon) => `${icon.sizes}:${icon.purpose}`);
    expect(bySize).toEqual(['192x192:any', '512x512:any', '512x512:maskable']);
    for (const icon of pwaManifest.icons) {
      expect(existsSync(path.resolve(webRoot, 'public', icon.src.slice(1))), icon.src).toBe(true);
    }
    expect(existsSync(path.resolve(webRoot, 'public/apple-touch-icon.png'))).toBe(true);
  });
});
