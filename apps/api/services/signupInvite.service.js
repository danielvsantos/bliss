import crypto from 'crypto';
import prisma from '../prisma/prisma.js';
import { normalizeEmail } from '../utils/normalizeEmail.js';

/**
 * Invite-only sign-up allowlist (#99).
 *
 * `SignupInvite.email` is deterministically encrypted (searchable) like
 * `User.email`, so the ciphertext depends on the exact plaintext bytes. Every
 * function here normalizes internally — callers cannot skip it — because one
 * un-normalized read or write silently never matches.
 *
 * Privacy rule: no function here logs a plaintext email. Logs carry an 8-hex
 * SHA-256 fingerprint at most.
 */

export const SIGNUP_INVITE_REQUIRED = 'SIGNUP_INVITE_REQUIRED';

/** The one response body for every rejected sign-up — listed, used, revoked or registered alike. */
export const INVITE_REQUIRED_BODY = Object.freeze({
  error: 'Sign-up on this instance is by invitation only.',
  code: SIGNUP_INVITE_REQUIRED,
});

export const NOTE_MAX_LENGTH = 200;

export class InviteRequiredError extends Error {
  constructor() {
    super('A valid, unused sign-up invite is required');
    this.name = 'InviteRequiredError';
    this.code = SIGNUP_INVITE_REQUIRED;
  }
}

export class InviteExistsError extends Error {
  constructor() {
    super('An invite for this email already exists');
    this.name = 'InviteExistsError';
    this.code = 'INVITE_EXISTS';
  }
}

export class InviteUsedError extends Error {
  constructor() {
    super('This invite has already been used and cannot be revoked');
    this.name = 'InviteUsedError';
    this.code = 'INVITE_ALREADY_USED';
  }
}

export class InviteNotFoundError extends Error {
  constructor() {
    super('Invite not found');
    this.name = 'InviteNotFoundError';
    this.code = 'INVITE_NOT_FOUND';
  }
}

/** Short, non-reversible tag for correlating log lines without the address. */
export function emailFingerprint(email) {
  const normalized = typeof email === 'string' ? normalizeEmail(email) : '';
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 8);
}

/** @param {'credentials'|'google'} path */
export function logInviteRejected(path, email) {
  console.warn(JSON.stringify({ event: 'signup_invite_rejected', path, emailFp: emailFingerprint(email) }));
}

/** @returns {Promise<boolean>} */
export async function hasUnusedInvite(email) {
  if (typeof email !== 'string' || !email.trim()) return false;
  const invite = await prisma.signupInvite.findFirst({
    where: { email: normalizeEmail(email), usedAt: null },
    select: { id: true },
  });
  return Boolean(invite);
}

/**
 * Atomically consume the invite inside the tenant-creation transaction.
 *
 * The conditional update (`usedAt IS NULL`) takes the row lock; a concurrent
 * sign-up with the same invite blocks on it, re-evaluates the predicate after
 * the first commits, matches 0 rows and throws — rolling back its whole tenant
 * creation. Exactly one tenant results.
 *
 * Returns the invite id; call logInviteConsumed() once the transaction has
 * committed, so a rolled-back sign-up never logs a consumption.
 *
 * @param {object} tx Prisma interactive-transaction client
 * @param {string} email
 * @param {string} tenantId
 * @returns {Promise<string|null>} the consumed invite's id
 * @throws {InviteRequiredError} when no unused invite exists (any more)
 */
export async function consumeInviteInTx(tx, email, tenantId) {
  const normalized = normalizeEmail(email);
  const { count } = await tx.signupInvite.updateMany({
    where: { email: normalized, usedAt: null },
    data: { usedAt: new Date(), usedByTenantId: tenantId },
  });
  if (count !== 1) throw new InviteRequiredError();

  const invite = await tx.signupInvite.findUnique({ where: { email: normalized }, select: { id: true } });
  return invite?.id ?? null;
}

/** @param {'credentials'|'google'} path */
export function logInviteConsumed(path, inviteId, tenantId) {
  console.log(JSON.stringify({ event: 'signup_invite_consumed', inviteId, tenantId, path }));
}

const PUBLIC_FIELDS = { id: true, email: true, note: true, createdAt: true, usedAt: true, usedByTenantId: true };

function serialize(invite) {
  return {
    id: invite.id,
    email: invite.email,
    note: invite.note ?? null,
    createdAt: invite.createdAt,
    usedAt: invite.usedAt ?? null,
    usedByTenantId: invite.usedByTenantId ?? null,
  };
}

/** @throws {InviteExistsError} */
export async function createInvite({ email, note }) {
  try {
    const invite = await prisma.signupInvite.create({
      data: { email: normalizeEmail(email), note: note ?? null },
      select: PUBLIC_FIELDS,
    });
    return serialize(invite);
  } catch (error) {
    if (error?.code === 'P2002') throw new InviteExistsError();
    throw error;
  }
}

/** @param {{ status?: 'unused'|'used' }} [opts] */
export async function listInvites({ status } = {}) {
  const where = status === 'unused' ? { usedAt: null } : status === 'used' ? { usedAt: { not: null } } : {};
  const invites = await prisma.signupInvite.findMany({
    where,
    select: PUBLIC_FIELDS,
    orderBy: { createdAt: 'desc' },
  });
  return invites.map(serialize);
}

/**
 * Revoke (delete) an unused invite. A used invite is audit history and its
 * tenant already exists, so it cannot be revoked.
 *
 * @param {{ email?: string, id?: string }} by
 * @throws {InviteNotFoundError|InviteUsedError}
 */
export async function revokeInvite({ email, id }) {
  const where = id ? { id } : { email: normalizeEmail(email) };
  const invite = await prisma.signupInvite.findUnique({ where, select: { id: true, usedAt: true } });
  if (!invite) throw new InviteNotFoundError();
  if (invite.usedAt) throw new InviteUsedError();

  // Conditional delete so an invite consumed between the read and the delete
  // is not removed from under its new tenant.
  const { count } = await prisma.signupInvite.deleteMany({ where: { id: invite.id, usedAt: null } });
  if (count !== 1) throw new InviteUsedError();
}
