/**
 * Minimum length for a NEW password (#78 R10): sign-up, change password and
 * Settings → Users "add user". The sign-in form never checks it, so an
 * existing shorter password still signs in. Mirrors apps/api/utils/passwordPolicy.js.
 */
export const PASSWORD_MIN_LENGTH = 8;
