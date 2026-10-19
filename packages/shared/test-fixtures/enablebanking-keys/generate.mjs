/**
 * Generates the Enable Banking test keys (#148). TEST ONLY: these keys sign
 * nothing real. Run once and commit the output:
 *
 *   node packages/shared/test-fixtures/enablebanking-keys/generate.mjs
 *
 * Both key parsers — parsePrivateKey() in @bliss/shared/enablebanking (server)
 * and apps/web/src/lib/pem.ts (browser pre-check) — are tested against these
 * files and `manifest.json`, so the two stay in step.
 *
 * `certificate.pem` needs the openssl CLI; it is kept when it already exists.
 */

import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const write = (name, content) => writeFileSync(join(dir, name), content);

const rsa = (bits) => generateKeyPairSync('rsa', { modulusLength: bits });
const k2048 = rsa(2048);
const k4096 = rsa(4096);
const k1024 = rsa(1024);
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

const pkcs8 = (k) => k.privateKey.export({ type: 'pkcs8', format: 'pem' });
const pkcs1 = (k) => k.privateKey.export({ type: 'pkcs1', format: 'pem' });

write('rsa2048-pkcs8.pem', pkcs8(k2048));
write('rsa2048-pkcs1.pem', pkcs1(k2048));
write('rsa4096-pkcs8.pem', pkcs8(k4096));
write('rsa4096-pkcs1.pem', pkcs1(k4096));
write('rsa4096-crlf.pem', `\r\n  ${pkcs8(k4096).replace(/\n/g, '\r\n')}\r\n\r\n`);
write('rsa4096-escaped.txt', pkcs8(k4096).trimEnd().replace(/\n/g, '\\n'));
write('rsa1024-pkcs8.pem', pkcs8(k1024));

const lines = pkcs8(k4096).trimEnd().split('\n');
write('truncated.pem', `${lines.slice(0, Math.floor(lines.length / 2)).join('\n')}\n`);
write('public.pem', k4096.publicKey.export({ type: 'spki', format: 'pem' }));
write('encrypted-pkcs8.pem', k2048.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'test' }));
write('encrypted-pkcs1.pem', k2048.privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'test' }));
write('ec-pkcs8.pem', ec.privateKey.export({ type: 'pkcs8', format: 'pem' }));
write('ec-sec1.pem', ec.privateKey.export({ type: 'sec1', format: 'pem' }));
write('not-pem.txt', 'this is not a key\n');
write('oversize.pem', `${pkcs8(k4096)}${'#'.repeat(16 * 1024)}\n`);

if (!existsSync(join(dir, 'certificate.pem'))) {
  const keyPath = join(dir, 'rsa2048-pkcs8.pem');
  execFileSync('openssl', ['req', '-new', '-x509', '-key', keyPath, '-subj', '/CN=bliss-test', '-days', '3650', '-out', join(dir, 'certificate.pem')]);
}

const manifest = {
  'rsa2048-pkcs8.pem': { ok: true, bits: 2048, key: 'k2048' },
  'rsa2048-pkcs1.pem': { ok: true, bits: 2048, key: 'k2048' },
  'rsa4096-pkcs8.pem': { ok: true, bits: 4096, key: 'k4096' },
  'rsa4096-pkcs1.pem': { ok: true, bits: 4096, key: 'k4096' },
  'rsa4096-crlf.pem': { ok: true, bits: 4096, key: 'k4096' },
  'rsa4096-escaped.txt': { ok: true, bits: 4096, key: 'k4096' },
  'rsa1024-pkcs8.pem': { ok: false, code: 'KEY_TOO_SMALL' },
  'truncated.pem': { ok: false, code: 'KEY_TRUNCATED' },
  'public.pem': { ok: false, code: 'KEY_PUBLIC' },
  'certificate.pem': { ok: false, code: 'KEY_CERTIFICATE' },
  'encrypted-pkcs8.pem': { ok: false, code: 'KEY_ENCRYPTED' },
  'encrypted-pkcs1.pem': { ok: false, code: 'KEY_ENCRYPTED' },
  'ec-pkcs8.pem': { ok: false, code: 'KEY_NOT_RSA' },
  'ec-sec1.pem': { ok: false, code: 'KEY_NOT_RSA' },
  'not-pem.txt': { ok: false, code: 'KEY_NOT_PEM' },
  'oversize.pem': { ok: false, code: 'KEY_TOO_LARGE' },
};
write('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
