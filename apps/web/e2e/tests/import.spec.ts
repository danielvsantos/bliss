import { test } from '@playwright/test';

/**
 * Smart CSV import E2E tests
 *
 * These tests cover the full smart import flow: adapter detection,
 * file upload, review, and commit.
 * Currently scaffolded as skips — implement alongside smart import UI stabilisation.
 */
test.describe('Smart CSV Import', () => {
  test.skip('user can upload a CSV file and detect the correct adapter', async () => {});
  test.skip('imported transactions appear in the review queue', async () => {});
  test.skip('user can override a category during review', async () => {});
  test.skip('committing a review batch creates permanent transactions', async () => {});
  test.skip('duplicate transactions are flagged and skipped on re-import', async () => {});
});
