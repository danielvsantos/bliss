const crypto = require('crypto');

/**
 * Compute a SHA-256 hash of a normalized description.
 *
 * Used as the unique key in TransactionEmbedding and GlobalEmbedding tables
 * so that plaintext descriptions are never stored at rest (Transaction.description
 * is AES-256-GCM encrypted, but the embedding tables previously stored plaintext).
 *
 * Normalization: lowercase + trim — identical to the normalization already
 * applied in upsertEmbedding() and upsertGlobalEmbedding().
 *
 * @param {string} description — Raw description text
 * @returns {string} — 64-char hex SHA-256 hash
 */
function computeDescriptionHash(description) {
  const normalized = (description || '').toLowerCase().trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

module.exports = { computeDescriptionHash };
