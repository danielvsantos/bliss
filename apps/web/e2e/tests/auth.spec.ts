import { test } from '@playwright/test';

/**
 * Authentication E2E tests
 *
 * These tests cover the sign-up and sign-in happy paths.
 * Currently scaffolded as skips — implement as the frontend auth pages stabilise.
 */
test.describe('Authentication', () => {
  test.skip('user can sign up with email and password and is redirected to dashboard', async () => {});
  test.skip('user can sign in with existing credentials', async () => {});
  test.skip('user is redirected to sign-in when accessing a protected route unauthenticated', async () => {});
  test.skip('user can sign out and session cookie is cleared', async () => {});
});
