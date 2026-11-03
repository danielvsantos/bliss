/**
 * Minimum length for a NEW password (#78 R10): signup, change-password and
 * admin "add user". Sign-in never checks it, so an existing shorter password
 * still works. Mirrored by apps/web/src/lib/password-policy.ts.
 */
export const PASSWORD_MIN_LENGTH = 8;
