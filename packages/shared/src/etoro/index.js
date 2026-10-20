/**
 * eToro copy trading (#143), shared by apps/api (ESM) and apps/backend (CJS)
 * through the dual tsup build.
 *
 * - instruments.js: pure eToro instrument → Twelve Data listing mapper
 * - scopes.js: read-only key check
 * - client.js: the read-only HTTP client (Node only) and response parsers
 * - holdings.js: a parsed copy → the holdings stored on EtoroCopy
 *
 * See docs/specs/backend/25-etoro-copy-trading.md.
 */

export * from './instruments.js';
export * from './scopes.js';
export * from './client.js';
export * from './holdings.js';
