/**
 * #78 R7: the web image sends anti-framing, nosniff and referrer headers on
 * every response. nginx drops outer add_headers in any location that sets its
 * own, so the snippet must be included in every location block.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

const DOCKER = join(__dirname, '../../../../../docker');
const conf = readFileSync(join(DOCKER, 'nginx.conf'), 'utf8');
const snippet = readFileSync(join(DOCKER, 'nginx-security-headers.conf'), 'utf8');
const dockerfile = readFileSync(join(DOCKER, 'Dockerfile.web'), 'utf8');

function locationBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /^\s*location\s[^{]*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (depth > 0 && i < text.length) {
      if (text[i] === '{') depth += 1;
      if (text[i] === '}') depth -= 1;
      i += 1;
    }
    blocks.push(text.slice(m.index, i));
  }
  return blocks;
}

describe('nginx security headers', () => {
  it('the snippet sets the four headers on every status code', () => {
    expect(snippet).toMatch(/add_header X-Frame-Options "DENY" always;/);
    expect(snippet).toMatch(/add_header Content-Security-Policy "frame-ancestors 'none'" always;/);
    expect(snippet).toMatch(/add_header X-Content-Type-Options "nosniff" always;/);
    expect(snippet).toMatch(/add_header Referrer-Policy "strict-origin-when-cross-origin" always;/);
  });

  it('every location block includes the snippet', () => {
    const blocks = locationBlocks(conf);
    expect(blocks.length).toBeGreaterThanOrEqual(7);
    for (const block of blocks) {
      expect(block).toContain('include /etc/nginx/snippets/security-headers.conf;');
    }
  });

  it('the web image copies the snippet where nginx.conf includes it', () => {
    expect(dockerfile).toContain('COPY docker/nginx-security-headers.conf /etc/nginx/snippets/security-headers.conf');
  });
});
