import { request } from '@playwright/test';

/**
 * E2E test setup helpers.
 *
 * These utilities create test data by calling the running API directly,
 * bypassing the UI for test setup speed.
 */

const API_BASE = process.env.E2E_API_URL || 'http://localhost:3000';

export interface TestUser {
  email: string;
  password: string;
  tenantId: string;
  token: string;
}

/**
 * Creates a fresh test user + tenant via the signup API.
 * Returns credentials for use in E2E test authentication.
 */
export async function createTestUser(suffix = ''): Promise<TestUser> {
  const label = suffix ? `-${suffix}` : '';
  const timestamp = Date.now();
  const email = `e2e${label}-${timestamp}@test.bliss`;
  const password = 'e2e-password-123';

  const context = await request.newContext({ baseURL: API_BASE });

  const res = await context.post('/api/auth/signup', {
    data: {
      email,
      password,
      tenantName: `E2E Tenant${label} ${timestamp}`,
      countries: [],
      currencies: [],
      bankIds: [],
    },
  });

  if (!res.ok()) {
    throw new Error(`E2E setup: signup failed with ${res.status()}: ${await res.text()}`);
  }

  const body = await res.json();
  const token = res.headers()['set-cookie']?.match(/token=([^;]+)/)?.[1] ?? '';

  return {
    email,
    password,
    tenantId: body.user.tenantId,
    token,
  };
}
