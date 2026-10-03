/**
 * /api/admin/invites — operator management of the invite-only sign-up
 * allowlist (#99).
 *
 *   GET    ?status=unused|used          → 200 { invites: [...] }
 *   POST   { email, note? }             → 201 { invite } | 409 INVITE_EXISTS
 *   DELETE { email } or { id } (JSON body; ?email= / ?id= also accepted)
 *                                       → 204 | 404 | 409 INVITE_ALREADY_USED
 *
 * Auth: x-admin-key header (ADMIN_API_KEY env var), failing closed when the key
 * is unset. Integration tokens are refused earlier by the central denylist.
 * Works whatever SIGNUP_MODE is, so invites can be pre-loaded before the gate
 * is turned on.
 *
 * This is the only route that returns invited emails. It never logs them.
 */

import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../utils/cors.js';
import { isAdminAuthorized } from '../../../utils/adminAuth.js';
import { normalizeEmail } from '../../../utils/normalizeEmail.js';
import {
  createInvite,
  listInvites,
  revokeInvite,
  InviteExistsError,
  InviteUsedError,
  InviteNotFoundError,
  NOTE_MAX_LENGTH,
} from '../../../services/signupInvite.service.js';

// Same format check as signup.js, applied after normalization.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUSES = ['unused', 'used'];

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

async function handleGet(req, res) {
  const status = firstQueryValue(req.query?.status);
  if (status !== undefined && !STATUSES.includes(status)) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'status must be "unused" or "used"' });
  }
  const invites = await listInvites({ status });
  return res.status(StatusCodes.OK).json({ invites });
}

async function handlePost(req, res) {
  const body = req.body ?? {};
  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
  if (!EMAIL_RE.test(email)) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'A valid email is required' });
  }

  let note = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string') {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: 'note must be a string' });
    }
    note = body.note.trim() || null;
    if (note && note.length > NOTE_MAX_LENGTH) {
      return res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: `note must be at most ${NOTE_MAX_LENGTH} characters` });
    }
  }

  try {
    const invite = await createInvite({ email, note });
    return res.status(StatusCodes.CREATED).json({ invite });
  } catch (error) {
    if (error instanceof InviteExistsError) {
      return res.status(StatusCodes.CONFLICT).json({ error: error.message, code: error.code });
    }
    throw error;
  }
}

async function handleDelete(req, res) {
  // The email may come in the JSON body (preferred: a query string lands in
  // platform access logs) or as ?email= for a quick curl.
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const id = body.id ?? firstQueryValue(req.query?.id);
  const rawEmail = body.email ?? firstQueryValue(req.query?.email);
  if (!id && !rawEmail) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'email or id is required' });
  }

  try {
    await revokeInvite(id ? { id: String(id) } : { email: String(rawEmail) });
    return res.status(StatusCodes.NO_CONTENT).end();
  } catch (error) {
    if (error instanceof InviteNotFoundError) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: error.message, code: error.code });
    }
    if (error instanceof InviteUsedError) {
      return res.status(StatusCodes.CONFLICT).json({ error: error.message, code: error.code });
    }
    throw error;
  }
}

export default async function handler(req, res) {
  if (cors(req, res)) return;

  if (!isAdminAuthorized(req, 'admin/invites')) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' });
  }

  try {
    switch (req.method) {
      case 'GET':
        return await handleGet(req, res);
      case 'POST':
        return await handlePost(req, res);
      case 'DELETE':
        return await handleDelete(req, res);
      default:
        res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
        return res.status(StatusCodes.METHOD_NOT_ALLOWED).end(`Method ${req.method} Not Allowed`);
    }
  } catch (error) {
    // Never log the request (it may carry an email): message only.
    console.error('admin/invites error:', error?.message);
    Sentry.captureException(error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Internal server error' });
  }
}
