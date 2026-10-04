/**
 * Sign-up mode (#99): who may create a new tenant on this instance.
 *
 *   SIGNUP_MODE unset / '' / 'open'  → open (anyone; the self-host default)
 *   SIGNUP_MODE = 'invite_only'      → only an email with an unused SignupInvite
 *   any other non-empty value        → invite_only (FAIL CLOSED)
 *
 * A typo such as `invite-only` locks sign-up rather than silently leaving it
 * open; validateEnv.js warns about it at boot.
 *
 * This module is the ONLY reader of `process.env.SIGNUP_MODE`, and it reads
 * on every call (never cached at module load) so operators and tests can
 * toggle the mode without a restart.
 */

const OPEN = 'open';
const INVITE_ONLY = 'invite_only';

function rawSignupMode() {
  return (process.env.SIGNUP_MODE ?? '').trim().toLowerCase();
}

/** @returns {'open'|'invite_only'} */
export function getSignupMode() {
  const raw = rawSignupMode();
  if (raw === '' || raw === OPEN) return OPEN;
  return INVITE_ONLY; // 'invite_only' and any unknown value → fail closed
}

export function isInviteOnly() {
  return getSignupMode() === INVITE_ONLY;
}

/** True when SIGNUP_MODE is set to something other than open/invite_only. */
export function isUnknownSignupMode() {
  const raw = rawSignupMode();
  return raw !== '' && raw !== OPEN && raw !== INVITE_ONLY;
}
