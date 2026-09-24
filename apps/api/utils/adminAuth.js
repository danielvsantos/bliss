import { timingSafeCompare } from './timingSafeCompare.js';

/**
 * Operator authentication for admin/maintenance routes: the `x-admin-key`
 * header checked against the `ADMIN_API_KEY` env var.
 *
 * This is a separate credential from `INTERNAL_API_KEY`, and deliberately so:
 * `INTERNAL_API_KEY` authenticates *service-to-service* calls from the API to
 * the backend, while `ADMIN_API_KEY` authenticates a *human operator* running
 * administrative actions by script. Blurring them would mean any service
 * compromise also granted admin, so they stay distinct.
 *
 * **Fails closed.** With `ADMIN_API_KEY` unset, every request is rejected —
 * an unset key must never mean "no auth required".
 *
 * The comparison is constant-time and length-guarded. It was previously `===`
 * in four separate copies of this function, which leaks the key a character at
 * a time to an attacker who can measure response timing. Extracted here so the
 * fix cannot drift back apart.
 *
 * @param {{ headers: Record<string, unknown> }} req
 * @param {string} label Route name, for the "key not set" warning.
 * @returns {boolean}
 */
export function isAdminAuthorized(req, label = 'admin') {
  const adminKey = process.env.ADMIN_API_KEY;

  if (!adminKey) {
    console.warn(`[${label}] ADMIN_API_KEY env var is not set — rejecting all requests`);
    return false;
  }

  const provided = req.headers['x-admin-key'];
  return timingSafeCompare(typeof provided === 'string' ? provided : '', adminKey);
}

export default isAdminAuthorized;
