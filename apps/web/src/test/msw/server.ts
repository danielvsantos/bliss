/**
 * MSW server for bliss-frontend tests.
 *
 * setupServer() creates a Node.js HTTP interceptor that works in Vitest's
 * jsdom environment. The server is started/stopped by src/test/setup.ts.
 */

import { setupServer } from 'msw/node';
import { handlers } from './handlers';

export const server = setupServer(...handlers);
