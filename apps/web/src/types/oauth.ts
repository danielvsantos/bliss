/**
 * OAuth consent for the MCP server (#89). Mirrors
 * apps/api/pages/api/oauth/requests/[id]/*.
 */
import type { IntegrationAccessLevel, KeyExpiryDays } from './integrations';

export interface OAuthConsentRequest {
  id: string;
  clientName: string;
  /** Host the browser is sent back to after approval — shown to the user. */
  redirectHost: string;
  /** The most the app asked for; consent may only grant this or less. */
  maxAccessLevel: IntegrationAccessLevel;
  expiresAt: string;
}

export interface OAuthConsentResponse {
  request: OAuthConsentRequest;
  canApprove: boolean;
  expiryOptions: KeyExpiryDays[];
}

export interface OAuthDecisionResponse {
  redirectUrl: string;
}
