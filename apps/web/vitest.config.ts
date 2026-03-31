import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

/**
 * Vitest configuration for bliss-frontend.
 *
 * Uses jsdom as the test environment to simulate browser APIs.
 * The @vitejs/plugin-react-swc plugin handles JSX and fast refresh.
 * The @ alias mirrors the one in vite.config.ts so imports resolve correctly.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    reporters: 'verbose',
    passWithNoTests: false,
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/components/**', 'src/hooks/**'],
      thresholds: {
        branches: 60,
        functions: 60,
        lines: 60,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
