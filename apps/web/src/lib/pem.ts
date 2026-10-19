/**
 * Browser pre-check of an Enable Banking private key (#148, R1a).
 *
 * Gives instant feedback ("Valid RSA private key · 4096-bit" or a specific
 * error) before anything is sent. The API's `parsePrivateKey()` in
 * `@bliss/shared/enablebanking` stays the authority; both are tested against
 * the same keys in `packages/shared/test-fixtures/enablebanking-keys/`, so
 * keep the two in step. Pure TypeScript, no dependencies: it only reads the
 * PEM headers and walks enough DER to find the RSA modulus.
 */

export const MAX_PRIVATE_KEY_BYTES = 16 * 1024;
export const MIN_RSA_BITS = 2048;

export type PemErrorCode =
  | 'KEY_NOT_PEM'
  | 'KEY_PUBLIC'
  | 'KEY_CERTIFICATE'
  | 'KEY_NOT_RSA'
  | 'KEY_ENCRYPTED'
  | 'KEY_TRUNCATED'
  | 'KEY_TOO_LARGE'
  | 'KEY_TOO_SMALL';

export type PemCheck = { ok: true; bits: number } | { ok: false; code: PemErrorCode };

const PEM_BEGIN = /-----BEGIN ([A-Z0-9 ]+)-----/;
// rsaEncryption, 1.2.840.113549.1.1.1
const RSA_OID = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

class DerError extends Error {}

type Tlv = { tag: number; start: number; end: number };

/** Reads one DER TLV at `offset`; `start`/`end` delimit its content. */
function readTlv(der: Uint8Array, offset: number): Tlv {
  if (offset + 2 > der.length) throw new DerError();
  const tag = der[offset];
  let length = der[offset + 1];
  let start = offset + 2;
  if (length & 0x80) {
    const n = length & 0x7f;
    if (n === 0 || n > 4 || start + n > der.length) throw new DerError();
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + der[start + i];
    start += n;
  }
  const end = start + length;
  if (end > der.length) throw new DerError();
  return { tag, start, end };
}

function expectTag(tlv: Tlv, tag: number): Tlv {
  if (tlv.tag !== tag) throw new DerError();
  return tlv;
}

/** Bit length of the modulus of a PKCS#1 RSAPrivateKey. */
function pkcs1ModulusBits(der: Uint8Array, offset = 0): number {
  const seq = expectTag(readTlv(der, offset), 0x30);
  const version = expectTag(readTlv(der, seq.start), 0x02);
  const modulus = expectTag(readTlv(der, version.end), 0x02);
  let i = modulus.start;
  while (i < modulus.end && der[i] === 0) i++;
  if (i >= modulus.end) throw new DerError();
  const top = der[i];
  return (modulus.end - i - 1) * 8 + (32 - Math.clz32(top));
}

/** PKCS#8: RSA modulus bits, or null when the algorithm is not RSA. */
function pkcs8ModulusBits(der: Uint8Array): number | null {
  const seq = expectTag(readTlv(der, 0), 0x30);
  const version = expectTag(readTlv(der, seq.start), 0x02);
  const algorithm = expectTag(readTlv(der, version.end), 0x30);
  const oid = expectTag(readTlv(der, algorithm.start), 0x06);
  const oidBytes = der.subarray(oid.start, oid.end);
  if (oidBytes.length !== RSA_OID.length || RSA_OID.some((b, i) => oidBytes[i] !== b)) return null;
  const key = expectTag(readTlv(der, algorithm.end), 0x04);
  return pkcs1ModulusBits(der.subarray(key.start, key.end));
}

function base64ToBytes(body: string): Uint8Array {
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Checks a pasted or uploaded private key. Accepts CRLF / CR line endings,
 * literal `\n` escapes (a key copied from a .env file), surrounding whitespace
 * and blank lines, PKCS#8 and PKCS#1 — like the API.
 */
export function checkPrivateKey(input: string): PemCheck {
  if (typeof input !== 'string' || input.trim() === '') return { ok: false, code: 'KEY_NOT_PEM' };
  if (new TextEncoder().encode(input).length > MAX_PRIVATE_KEY_BYTES) return { ok: false, code: 'KEY_TOO_LARGE' };

  const text = input.replace(/\\r\\n|\\n|\\r/g, '\n').replace(/\r\n?/g, '\n').trim();
  const begin = PEM_BEGIN.exec(text);
  if (!begin) return { ok: false, code: 'KEY_NOT_PEM' };
  const label = begin[1].trim();
  if (label.includes('CERTIFICATE')) return { ok: false, code: 'KEY_CERTIFICATE' };
  if (label.includes('PUBLIC KEY')) return { ok: false, code: 'KEY_PUBLIC' };
  if (label === 'ENCRYPTED PRIVATE KEY' || /Proc-Type:\s*4,\s*ENCRYPTED/i.test(text)) return { ok: false, code: 'KEY_ENCRYPTED' };
  if (label === 'EC PRIVATE KEY' || label === 'DSA PRIVATE KEY') return { ok: false, code: 'KEY_NOT_RSA' };
  if (label !== 'PRIVATE KEY' && label !== 'RSA PRIVATE KEY') return { ok: false, code: 'KEY_NOT_PEM' };

  const bodyStart = begin.index + begin[0].length;
  const endIndex = text.indexOf(`-----END ${label}-----`, bodyStart);
  if (endIndex === -1) return { ok: false, code: 'KEY_TRUNCATED' };
  const body = text.slice(bodyStart, endIndex).replace(/\s+/g, '');
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return { ok: false, code: 'KEY_NOT_PEM' };

  let bits: number | null;
  try {
    const der = base64ToBytes(body);
    bits = label === 'RSA PRIVATE KEY' ? pkcs1ModulusBits(der) : pkcs8ModulusBits(der);
  } catch {
    return { ok: false, code: 'KEY_TRUNCATED' };
  }
  if (bits === null) return { ok: false, code: 'KEY_NOT_RSA' };
  if (bits < MIN_RSA_BITS) return { ok: false, code: 'KEY_TOO_SMALL' };
  return { ok: true, bits };
}
