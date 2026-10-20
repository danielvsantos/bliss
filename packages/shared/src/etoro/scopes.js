/**
 * eToro key scope check (#143, PRD R2).
 *
 * Bliss only ever reads from eToro. A key whose `/api/v1/me` scope list holds
 * anything other than `…:read` is refused before it is stored.
 */

export class EtoroScopeError extends Error {
  constructor(writeScopes) {
    super('eToro key has write scopes; create a Read key instead');
    this.name = 'EtoroScopeError';
    this.code = 'ETORO_WRITE_SCOPE';
    this.writeScopes = writeScopes;
  }
}

/** True for a scope like `trade.real:read` (case-insensitive). */
export function isReadScope(scope) {
  return typeof scope === 'string' && /:read$/i.test(scope.trim());
}

/**
 * Throws `EtoroScopeError` unless every scope is a read scope. An empty or
 * missing list is refused too: a key that reports no scopes can't be proven
 * read-only.
 *
 * @param {string[]} scopes
 * @returns {string[]} the scopes, trimmed
 */
export function assertReadOnlyScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) throw new EtoroScopeError([]);
  const trimmed = scopes.map((s) => (typeof s === 'string' ? s.trim() : s));
  const writeScopes = trimmed.filter((s) => !isReadScope(s));
  if (writeScopes.length > 0) throw new EtoroScopeError(writeScopes);
  return trimmed;
}
