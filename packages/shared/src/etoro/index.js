/**
 * eToro copy trading (#143), shared by apps/api (ESM) and apps/backend (CJS)
 * through the dual tsup build.
 *
 * This slice holds the pure parts only: the instrument mapper and the scope
 * check. The HTTP client lands with the sync (implementation plan step 4).
 *
 * See docs/specs/backend/25-etoro-copy-trading.md.
 */

export * from './instruments.js';
export * from './scopes.js';
