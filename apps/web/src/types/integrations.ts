/**
 * Integrations & API tokens (#84). Mirrors the payloads of
 * apps/api/pages/api/integrations/*. A plaintext `token` only ever appears in
 * the create responses — never in a list.
 */

export type IntegrationAccessLevel = 'READ_ONLY' | 'READ_WRITE';
export type ApiKeyStatus = 'active' | 'revoked' | 'expired';
export type KeyExpiryDays = 30 | 90 | 365 | null;

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  status: ApiKeyStatus;
}

export interface Integration {
  id: string;
  name: string;
  description: string | null;
  accessLevel: IntegrationAccessLevel;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  status: 'active' | 'revoked';
  keyCount: number;
  activeKeyCount: number;
  lastUsedAt: string | null;
  keys: ApiKeySummary[];
}

export interface CreateApiKeyRequest {
  name?: string;
  expiresInDays: KeyExpiryDays;
}

export interface CreateIntegrationRequest {
  name: string;
  description?: string;
  accessLevel: IntegrationAccessLevel;
  key: CreateApiKeyRequest;
}

export interface CreateIntegrationResponse {
  integration: Integration;
  apiKey: ApiKeySummary;
  token: string;
}

export interface CreateApiKeyResponse {
  apiKey: ApiKeySummary;
  token: string;
}
