/**
 * POST /api/plaid/webhook
 *
 * Receives webhook events from Plaid and routes them into the internal
 * event pipeline. NOT protected by JWT — Plaid calls this endpoint
 * directly from their servers.
 *
 * Webhook Signature Verification:
 *   Plaid signs every webhook with an ES256 JWT in the `Plaid-Verification`
 *   header. The JWT payload includes `request_body_sha256` (hash of the raw body)
 *   and `iat` (issued-at, used for replay prevention).
 *
 *   In PRODUCTION  → full verification enforced; requests failing verification are rejected.
 *   In DEVELOPMENT → verification is skipped (logged as warning) so sandbox
 *                    webhooks from Plaid's dashboard can be tested without TLS.
 *
 * Handled events:
 *   TRANSACTIONS.SYNC_UPDATES_AVAILABLE → emit PLAID_SYNC_UPDATES to backend pipeline
 *   TRANSACTIONS.HISTORICAL_UPDATE      → emit PLAID_SYNC_UPDATES (full history available)
 *   ITEM.ERROR                          → update PlaidItem.status + errorCode
 *   ITEM.LOGIN_REQUIRED                 → update PlaidItem.status = LOGIN_REQUIRED
 *   ITEM.USER_PERMISSION_REVOKED        → update PlaidItem.status = REVOKED
 *   ITEM.WEBHOOK_UPDATE_ACKNOWLEDGED    → no-op (log only)
 *
 * All other webhook types are logged and ignored.
 *
 * Plaid expects a 2xx response quickly; we return 200 before async processing
 * so Plaid never retries due to processing latency on our side.
 */

import { StatusCodes } from 'http-status-codes';
import { plaidClient } from '../../../services/plaid.service';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../prisma/prisma';
import { produceEvent } from '../../../utils/produceEvent.js';
import { importJWK, compactVerify } from 'jose';

// ── Webhook Key Cache ──────────────────────────────────────────────────────────
// Plaid's verification keys rotate infrequently (announced via webhook).
// Cache them in-memory to avoid a Plaid API round-trip on every webhook call.
const verificationKeyCache = new Map();

/**
 * Fetch (and cache) Plaid's public verification key by key ID.
 * @param {string} kid — Key ID extracted from the verification JWT header.
 */
async function getVerificationKey(kid) {
  if (verificationKeyCache.has(kid)) {
    return verificationKeyCache.get(kid);
  }
  const response = await plaidClient.webhookVerificationKeyGet({ key_id: kid });
  const jwk = response.data.key;
  verificationKeyCache.set(kid, jwk);
  return jwk;
}

/**
 * Verify the `Plaid-Verification` header.
 * Confirms the request was signed by Plaid and is not a replay (max 5-min age).
 *
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<boolean>} true if valid, false otherwise.
 */
async function verifyWebhookSignature(req) {
  const token = req.headers['plaid-verification'];
  if (!token) {
    console.warn('[webhook] Missing plaid-verification header');
    return false;
  }

  try {
    // Decode JWT header without verifying — we need `kid` to fetch the right key.
    const [headerB64] = token.split('.');
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    const { kid } = header;

    if (!kid) {
      console.warn('[webhook] JWT header is missing kid');
      return false;
    }

    // Fetch Plaid's public key (JWK format) and import it for verification.
    const jwk = await getVerificationKey(kid);
    const publicKey = await importJWK(jwk, 'ES256');

    // Verify the JWT signature. compactVerify throws on failure.
    const { payload: rawPayload } = await compactVerify(token, publicKey);
    const payload = JSON.parse(Buffer.from(rawPayload).toString('utf8'));

    // Reject stale tokens to prevent replay attacks (5-minute window).
    const now = Math.floor(Date.now() / 1000);
    if (!payload.iat || now - payload.iat > 300) {
      console.warn('[webhook] JWT is stale or missing iat — possible replay attack');
      return false;
    }

    return true;
  } catch (err) {
    console.warn('[webhook] Signature verification failed:', err.message);
    return false;
  }
}

// ── Route handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(StatusCodes.OK).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  // ── Signature Verification ─────────────────────────────────────────────────
  if (process.env.NODE_ENV === 'production') {
    const isValid = await verifyWebhookSignature(req).catch((err) => {
      Sentry.captureException(err);
      return false;
    });
    if (!isValid) {
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Invalid webhook signature' });
    }
  } else {
    // Development / sandbox: skip verification so we can test via Plaid dashboard
    // without an HTTPS-reachable URL.
    console.warn('[webhook] Skipping signature verification in non-production environment');
  }

  const { webhook_type, webhook_code, item_id, error: plaidError } = req.body;

  console.log(`[webhook] ${webhook_type}.${webhook_code} — item_id: ${item_id}`);

  // ── Acknowledge immediately ────────────────────────────────────────────────
  // Plaid retries if it doesn't receive a 2xx promptly. Send 200 before
  // async processing so network latency never triggers a retry.
  res.status(StatusCodes.OK).json({ received: true });

  // ── Process event (after response is sent) ────────────────────────────────
  try {
    if (!item_id) {
      console.warn('[webhook] Missing item_id in payload — ignoring');
      return;
    }

    // Resolve our internal PlaidItem using Plaid's item_id (not our cuid).
    const plaidItem = await prisma.plaidItem.findFirst({
      where: { itemId: item_id },
      select: { id: true, tenantId: true, status: true },
    });

    if (!plaidItem) {
      // Could be an item from a different environment (sandbox vs production).
      console.warn(`[webhook] No PlaidItem found for Plaid item_id: ${item_id}`);
      return;
    }

    switch (webhook_type) {
      // ── TRANSACTIONS ──────────────────────────────────────────────────────
      case 'TRANSACTIONS': {
        if (
          webhook_code === 'SYNC_UPDATES_AVAILABLE' ||
          webhook_code === 'HISTORICAL_UPDATE'
        ) {
          // Only sync items that are ACTIVE — skip REVOKED, LOGIN_REQUIRED, ERROR.
          if (plaidItem.status !== 'ACTIVE') {
            console.log(
              `[webhook] Skipping sync for item ${plaidItem.id}: status is ${plaidItem.status}`
            );
            return;
          }

          await produceEvent({
            type: 'PLAID_SYNC_UPDATES',
            tenantId: plaidItem.tenantId,
            plaidItemId: plaidItem.id,
            source: `WEBHOOK_${webhook_code}`,
          });

          console.log(
            `[webhook] Enqueued PLAID_SYNC_UPDATES for item ${plaidItem.id} (${webhook_code})`
          );
        } else {
          console.log(`[webhook] Unhandled TRANSACTIONS code: ${webhook_code}`);
        }
        break;
      }

      // ── ITEM ──────────────────────────────────────────────────────────────
      case 'ITEM': {
        switch (webhook_code) {
          case 'ERROR': {
            // plaidError shape: { error_type, error_code, error_message }
            const errorCode = plaidError?.error_code ?? 'UNKNOWN_ERROR';
            const newStatus =
              errorCode === 'ITEM_LOGIN_REQUIRED' ? 'LOGIN_REQUIRED' : 'ERROR';

            await prisma.plaidItem.update({
              where: { id: plaidItem.id },
              data: { status: newStatus, errorCode, updatedAt: new Date() },
            });

            console.log(
              `[webhook] Item ${plaidItem.id} → status: ${newStatus}, errorCode: ${errorCode}`
            );
            break;
          }

          case 'LOGIN_REQUIRED': {
            // Some Plaid environments send this as a distinct code rather than
            // inside an ERROR event. Handle both.
            await prisma.plaidItem.update({
              where: { id: plaidItem.id },
              data: { status: 'LOGIN_REQUIRED', updatedAt: new Date() },
            });
            console.log(`[webhook] Item ${plaidItem.id} → status: LOGIN_REQUIRED`);
            break;
          }

          case 'USER_PERMISSION_REVOKED': {
            // The user revoked access directly through their bank or Plaid portal.
            await prisma.plaidItem.update({
              where: { id: plaidItem.id },
              data: { status: 'REVOKED', updatedAt: new Date() },
            });
            console.log(`[webhook] Item ${plaidItem.id} → status: REVOKED (user revoked at bank)`);
            break;
          }

          case 'WEBHOOK_UPDATE_ACKNOWLEDGED': {
            // Plaid confirming our registered webhook URL — no action needed.
            console.log(`[webhook] Webhook URL update acknowledged for item ${plaidItem.id}`);
            break;
          }

          default:
            console.log(`[webhook] Unhandled ITEM code: ${webhook_code} for item ${plaidItem.id}`);
        }
        break;
      }

      default:
        console.log(`[webhook] Unhandled webhook_type: ${webhook_type}`);
    }
  } catch (error) {
    // Response already sent — just log and capture. Never re-throw here.
    Sentry.captureException(error);
    console.error('[webhook] Error processing webhook after response:', error.message);
  }
}
