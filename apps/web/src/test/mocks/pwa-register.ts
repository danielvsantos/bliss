import { vi } from 'vitest';
import type { RegisterSWOptions } from 'vite-plugin-pwa/types';

/**
 * Stand-in for `virtual:pwa-register` (aliased in vitest.config.ts). Tests read
 * the options passed to the last registerSW() call from `lastOptions` and
 * drive its callbacks directly.
 */
export const updateSW = vi.fn(async (_reloadPage?: boolean) => {});
export const pwaRegisterMock: { lastOptions: RegisterSWOptions | null } = { lastOptions: null };

export function registerSW(options: RegisterSWOptions = {}) {
  pwaRegisterMock.lastOptions = options;
  return updateSW;
}
