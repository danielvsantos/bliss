/**
 * Canonical form of an email address for storage and lookup.
 *
 * Deliberately minimal: trim surrounding whitespace, lowercase. **No** dot
 * stripping and **no** plus-tag removal. Those change identity semantics —
 * `a.b@example.com` and `ab@example.com` are the same mailbox at Gmail and
 * different mailboxes almost everywhere else — and folding them would silently
 * merge accounts that their owners consider separate.
 *
 * Why this matters more here than in most codebases
 * -------------------------------------------------
 * `User.email` is encrypted with `{ searchable: true }`, i.e. deterministic
 * encryption: the salt and IV are derived from a SHA-256 of the plaintext
 * (packages/shared/src/encryption.js). The ciphertext is a pure function of the
 * exact plaintext bytes, so `A@x.com` and `a@x.com` produce entirely different
 * ciphertexts and will never match each other in a WHERE clause.
 *
 * The consequence: normalization must be applied at **every** read and write.
 * Missing one site produces a login that works for some users and not others,
 * a failure that is data-dependent and invisible to fixtures written in
 * lowercase. The closed set of call sites is signup.js, signin.js, and the
 * three AuthService methods (findUserByEmail, createUser,
 * findOrCreateGoogleUser).
 *
 * @param {unknown} email
 * @returns {unknown} the normalized string, or the input unchanged when it is
 *   not a string (so callers' own validation reports the real problem).
 */
export function normalizeEmail(email) {
  if (typeof email !== 'string') return email;
  return email.trim().toLowerCase();
}

export default normalizeEmail;
