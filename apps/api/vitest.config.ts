import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    reporter: 'verbose',
    include: ['__tests__/**/*.test.{js,ts}'],
    setupFiles: [
      '__tests__/setup/env.ts',    // sets ENCRYPTION_SECRET etc. before any module imports
      '__tests__/setup/sentry.ts', // mocks @sentry/nextjs
    ],
    coverage: {
      provider: 'v8',
      include: ['pages/api/**', 'utils/**'],
      exclude: ['pages/api/auth/[...nextauth].js'],
      thresholds: { lines: 70, functions: 70, branches: 60 },
    },
  },
});
