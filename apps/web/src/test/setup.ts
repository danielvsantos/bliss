/**
 * Vitest global test setup for bliss-frontend.
 *
 * - Imports @testing-library/jest-dom matchers (toBeInTheDocument, toHaveValue, etc.)
 * - Starts the MSW service worker server before all tests
 * - Resets MSW handlers after each test to prevent cross-test pollution
 * - Closes the server after all tests
 */

import '@testing-library/jest-dom';
import { beforeAll, afterAll, afterEach } from 'vitest';
import { server } from './msw/server';

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
