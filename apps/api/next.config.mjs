import { withSentryConfig } from '@sentry/nextjs';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildHeaderRules } from './utils/securityHeaders.js';

// Load environment variables from monorepo root .env
// (Next.js only auto-loads from the app directory; this ensures the unified root .env is used)
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../.env') });

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',

  // Security headers. NOTE: Next evaluates this at BUILD time and bakes the
  // result into routes-manifest.json — it is never re-run at runtime, so no
  // runtime env var can be read here. HSTS is therefore gated by a `has`
  // matcher on x-forwarded-proto, which the router evaluates per request.
  // See utils/securityHeaders.js.
  async headers() {
    return buildHeaderRules();
  },

  // Packages that use native Node.js modules or dynamic require() patterns
  // that webpack cannot bundle. Resolved from node_modules at runtime instead.
  // - @google-cloud/storage: uses native Node.js modules
  // - The full @opentelemetry stack: transitively imports protobufjs, which
  //   uses a dynamic require() in inquire.js. These are server-only
  //   instrumentation packages and must not be bundled by webpack.
  serverExternalPackages: [
    '@google-cloud/storage',
    '@opentelemetry/sdk-node',
    '@opentelemetry/auto-instrumentations-node',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/exporter-trace-otlp-grpc',
    '@opentelemetry/exporter-logs-otlp-grpc',
    '@opentelemetry/otlp-transformer',
    'protobufjs',
  ],

  webpack(config) {
    // protobufjs uses a dynamic require() in inquire.js that webpack cannot
    // statically analyze, producing a "Critical dependency" warning. The
    // packages are server-external so they work correctly at runtime — this
    // just suppresses the noisy false-positive during compilation.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      { module: /node_modules\/protobufjs/ },
    ];
    return config;
  },
};

export default withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
});
