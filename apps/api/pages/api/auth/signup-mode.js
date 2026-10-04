import { StatusCodes } from 'http-status-codes';
import { cors } from '../../../utils/cors.js';
import { isInviteOnly } from '../../../utils/signupMode.js';

/**
 * GET /api/auth/signup-mode — public flag for the auth page (#99).
 *
 * The SPA is a static bundle and cannot read SIGNUP_MODE, so it asks here to
 * decide whether to show the invite-only notice. Returns `{ inviteOnly }` and
 * nothing else: no counts, no emails, no version or env details (unlike the
 * admin-only /api/runtime). No DB access, so no rate limiter. The server stays
 * authoritative: signup.js and the Google path enforce the gate themselves.
 */
export default function handler(req, res) {
  if (cors(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    res.status(StatusCodes.METHOD_NOT_ALLOWED).end(`Method ${req.method} Not Allowed`);
    return;
  }

  res.setHeader('Cache-Control', 'public, max-age=60');
  res.status(StatusCodes.OK).json({ inviteOnly: isInviteOnly() });
}
