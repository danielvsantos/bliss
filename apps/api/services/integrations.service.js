import { ALLOWED_EXPIRY_DAYS, expiryFromDays, generateApiKey, keyStatus } from '../utils/apiKeys.js';
import { INTEGRATION_ACCESS_LEVELS } from '../utils/integrationPolicy.js';

/**
 * Integrations & API keys (#84) — validation and serialization shared by the
 * pages/api/integrations/* handlers. Nothing here ever selects or returns
 * `keyHash`; the plaintext token is only returned by the create paths.
 */

export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 280;
export const KEY_NAME_MAX = 80;
export const DEFAULT_KEY_NAME = 'Default key';

/** Columns safe to return for a key. keyHash is deliberately absent. */
export const API_KEY_PUBLIC_SELECT = {
  id: true,
  name: true,
  prefix: true,
  expiresAt: true,
  lastUsedAt: true,
  createdAt: true,
  revokedAt: true,
};

export function serializeApiKey(key, now = new Date()) {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
    createdAt: key.createdAt,
    revokedAt: key.revokedAt,
    status: keyStatus(key, now),
  };
}

export function serializeIntegration(integration, now = new Date()) {
  const keys = (integration.apiKeys || []).map((k) => serializeApiKey(k, now));
  const lastUsedAt = keys.reduce((latest, k) => {
    if (!k.lastUsedAt) return latest;
    return !latest || new Date(k.lastUsedAt) > new Date(latest) ? k.lastUsedAt : latest;
  }, null);

  return {
    id: integration.id,
    name: integration.name,
    description: integration.description,
    accessLevel: integration.accessLevel,
    createdByUserId: integration.createdByUserId,
    createdAt: integration.createdAt,
    updatedAt: integration.updatedAt,
    revokedAt: integration.revokedAt,
    status: integration.revokedAt ? 'revoked' : 'active',
    keyCount: keys.length,
    activeKeyCount: keys.filter((k) => k.status === 'active').length,
    lastUsedAt,
    keys,
  };
}

function isNonEmptyString(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
}

/**
 * @returns {{ ok: true, value: { name?: string, expiresInDays: number|null } } | { ok: false, error: string }}
 */
export function validateKeyInput(input = {}) {
  const body = input && typeof input === 'object' ? input : {};
  const { name, expiresInDays } = body;

  if (name !== undefined && name !== null && !isNonEmptyString(name, KEY_NAME_MAX)) {
    return { ok: false, error: `Key name must be 1–${KEY_NAME_MAX} characters` };
  }
  if (!('expiresInDays' in body)) {
    return { ok: false, error: 'expiresInDays is required (30, 90, 365 or null for no expiry)' };
  }
  if (!ALLOWED_EXPIRY_DAYS.includes(expiresInDays)) {
    return { ok: false, error: 'expiresInDays must be 30, 90, 365 or null' };
  }
  return { ok: true, value: { name: name ? name.trim() : undefined, expiresInDays } };
}

/**
 * @returns {{ ok: true, value: { name, description, accessLevel, key } } | { ok: false, error: string }}
 */
export function validateCreateIntegration(body = {}) {
  const { name, description, accessLevel, key } = body || {};

  if (!isNonEmptyString(name, NAME_MAX)) {
    return { ok: false, error: `Name must be 1–${NAME_MAX} characters` };
  }
  if (description !== undefined && description !== null && description !== '') {
    if (typeof description !== 'string' || description.length > DESCRIPTION_MAX) {
      return { ok: false, error: `Description must be at most ${DESCRIPTION_MAX} characters` };
    }
  }
  if (!INTEGRATION_ACCESS_LEVELS.includes(accessLevel)) {
    return { ok: false, error: 'accessLevel must be READ_ONLY or READ_WRITE' };
  }
  const keyResult = validateKeyInput(key);
  if (!keyResult.ok) return keyResult;

  return {
    ok: true,
    value: {
      name: name.trim(),
      description: description ? description.trim() : null,
      accessLevel,
      key: keyResult.value,
    },
  };
}

/**
 * @returns {{ ok: true, value: { name?: string, description?: string|null } } | { ok: false, error: string, code?: string }}
 */
export function validateUpdateIntegration(body = {}) {
  const input = body || {};
  if ('accessLevel' in input) {
    return {
      ok: false,
      code: 'ACCESS_LEVEL_IMMUTABLE',
      error: 'The access level of an integration cannot be changed. Create a new integration instead.',
    };
  }

  const data = {};
  if (input.name !== undefined) {
    if (!isNonEmptyString(input.name, NAME_MAX)) {
      return { ok: false, error: `Name must be 1–${NAME_MAX} characters` };
    }
    data.name = input.name.trim();
  }
  if (input.description !== undefined) {
    if (input.description !== null && (typeof input.description !== 'string' || input.description.length > DESCRIPTION_MAX)) {
      return { ok: false, error: `Description must be at most ${DESCRIPTION_MAX} characters` };
    }
    data.description = input.description ? input.description.trim() : null;
  }
  if (Object.keys(data).length === 0) {
    return { ok: false, error: 'Nothing to update: provide name and/or description' };
  }
  return { ok: true, value: data };
}

/**
 * Build the `ApiKey` create payload plus the one-time plaintext token.
 *
 * @returns {{ data: object, token: string }}
 */
export function buildApiKey({ tenantId, integrationId, name, expiresInDays }, now = new Date()) {
  const { token, prefix, keyHash } = generateApiKey();
  const data = {
    tenantId,
    name: name || DEFAULT_KEY_NAME,
    prefix,
    keyHash,
    expiresAt: expiryFromDays(expiresInDays, now),
  };
  if (integrationId) data.integrationId = integrationId;
  return { data, token };
}
