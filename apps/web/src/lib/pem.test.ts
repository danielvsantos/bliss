/**
 * The browser key pre-check (#148) against the shared test keys — the same
 * fixtures the API's parsePrivateKey() is tested with, so the two agree.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { checkPrivateKey } from './pem';

const KEYS_DIR = join(__dirname, '../../../../packages/shared/test-fixtures/enablebanking-keys');
const read = (name: string) => readFileSync(join(KEYS_DIR, name), 'utf8');
const MANIFEST: Record<string, { ok: boolean; bits?: number; code?: string }> = JSON.parse(read('manifest.json'));

describe('checkPrivateKey', () => {
  const entries = Object.entries(MANIFEST);

  it.each(entries.filter(([, e]) => e.ok))('accepts %s', (file, expected) => {
    expect(checkPrivateKey(read(file))).toEqual({ ok: true, bits: expected.bits });
  });

  it.each(entries.filter(([, e]) => !e.ok))('rejects %s with the API\'s code', (file, expected) => {
    expect(checkPrivateKey(read(file))).toEqual({ ok: false, code: expected.code });
  });

  it('rejects empty input and garbage between valid markers', () => {
    expect(checkPrivateKey('')).toEqual({ ok: false, code: 'KEY_NOT_PEM' });
    expect(checkPrivateKey('   \n ')).toEqual({ ok: false, code: 'KEY_NOT_PEM' });
    expect(checkPrivateKey('-----BEGIN PRIVATE KEY-----\n!!!\n-----END PRIVATE KEY-----')).toEqual({ ok: false, code: 'KEY_NOT_PEM' });
    expect(checkPrivateKey('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----')).toEqual({ ok: false, code: 'KEY_TRUNCATED' });
  });

  it('accepts leading and trailing whitespace around a key', () => {
    expect(checkPrivateKey(`\n\n  ${read('rsa2048-pkcs1.pem')}  \n`)).toEqual({ ok: true, bits: 2048 });
  });
});
