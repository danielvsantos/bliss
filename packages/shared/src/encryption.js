import crypto from 'crypto';

const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET;
const ENCRYPTION_SECRET_PREVIOUS = process.env.ENCRYPTION_SECRET_PREVIOUS || null;
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 16;

if (!ENCRYPTION_SECRET) {
  throw new Error('ENCRYPTION_SECRET environment variable is required for data encryption');
}

// ─── Key derivation cache ─────────────────────────────────────────────────────
// PBKDF2 with 100k iterations is expensive (~50-80ms per call).
// During batch processing (500+ transactions) this becomes a bottleneck.
// Cache derived keys in memory keyed by salt hex. LRU-style with max size.
const KEY_CACHE_MAX_SIZE = 500;
const keyCache = new Map();

// Derive a key from the master secret and salt (with in-memory caching).
// The cache key is namespaced by which secret is in use so current and
// previous keys never share cache entries.
function deriveKey(salt, secret = ENCRYPTION_SECRET) {
  const ns = secret === ENCRYPTION_SECRET ? 'cur' : 'prv';
  const cacheKey = `${ns}:${salt.toString('hex')}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  const derived = crypto.pbkdf2Sync(secret, salt, 100000, 32, 'sha256');

  // Simple LRU: evict oldest entry when cache is full
  if (keyCache.size >= KEY_CACHE_MAX_SIZE) {
    const firstKey = keyCache.keys().next().value;
    keyCache.delete(firstKey);
  }
  keyCache.set(cacheKey, derived);

  return derived;
}

// Generate deterministic salt and IV for searchable fields
function generateSearchComponents(text) {
  const textBuffer = Buffer.from(text, 'utf8');
  const salt = crypto.createHash('sha256').update(textBuffer).digest().subarray(0, SALT_LENGTH);
  const iv = crypto.createHash('sha256').update(salt).digest().subarray(0, IV_LENGTH);
  return { salt, iv };
}

// Encrypt a value with option for searchable encryption
export function encrypt(text, isSearchable = false) {
  if (!text) return text;

  let salt, iv;
  if (isSearchable) {
    const components = generateSearchComponents(text);
    salt = components.salt;
    iv = components.iv;
  } else {
    salt = crypto.randomBytes(SALT_LENGTH);
    iv = crypto.randomBytes(IV_LENGTH);
  }

  const key = deriveKey(salt);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // Layout: salt (16) + iv (12) + authTag (16) + encrypted data
  return Buffer.concat([salt, iv, authTag, encrypted]).toString('base64');
}

// Internal: attempt decryption with a specific secret — throws on auth-tag failure.
function decryptWithSecret(encryptedText, secret) {
  const MIN_ENCRYPTED_LENGTH = SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1;
  const buffer = Buffer.from(encryptedText, 'base64');
  if (buffer.length < MIN_ENCRYPTED_LENGTH) return encryptedText; // plain text / legacy

  const salt      = buffer.subarray(0, SALT_LENGTH);
  const iv        = buffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag   = buffer.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = buffer.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = deriveKey(salt, secret);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// Decrypt a value — tries ENCRYPTION_SECRET first; if that fails and
// ENCRYPTION_SECRET_PREVIOUS is set (key rotation in progress), falls back
// to the previous secret so data encrypted under either key can be read.
export function decrypt(encryptedText) {
  if (!encryptedText) return encryptedText;

  try {
    return decryptWithSecret(encryptedText, ENCRYPTION_SECRET);
  } catch (primaryError) {
    if (ENCRYPTION_SECRET_PREVIOUS) {
      try {
        return decryptWithSecret(encryptedText, ENCRYPTION_SECRET_PREVIOUS);
      } catch {
        // Both keys failed — fall through
      }
    }
    if (process.env.NODE_ENV === 'development') {
      console.error('Decryption failed:', primaryError);
    }
    return encryptedText;
  }
}

// Fields that should be encrypted for each model, with searchable flag
export const encryptedFields = {
  User: {
    email: { searchable: true },
  },
  Account: {
    accountNumber: { searchable: false },
  },
  Transaction: {
    details: { searchable: false },
    description: { searchable: false },
  },
  PlaidItem: {
    accessToken: { searchable: false },
  },
};
