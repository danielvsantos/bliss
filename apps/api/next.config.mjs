import { withSentryConfig } from '@sentry/nextjs';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from monorepo root .env
// (Next.js only auto-loads from the app directory; this ensures the unified root .env is used)
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../.env') });

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: process.env.VERCEL ? undefined : 'standalone',
  // @google-cloud/storage uses native Node.js modules that webpack cannot
  // bundle. Mark as external so Next.js resolves it from node_modules at runtime.
  serverExternalPackages: ['@google-cloud/storage'],
};

export default withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
});
