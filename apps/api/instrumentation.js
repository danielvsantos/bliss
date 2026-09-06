export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Validate environment variables early
    const { validateEnv } = await import('./utils/validateEnv.js');
    validateEnv();

    // Logs the SHA-256 prefix of the loaded ENCRYPTION_SECRET (never the secret
    // itself) so an operator can confirm which key a running instance has
    // picked up during a rotation. See docs/guides/key-rotation.md §2.
    const { keyFingerprint } = await import('./utils/encryption.js');
    console.log('[env] ENCRYPTION_SECRET fingerprint:', keyFingerprint());

    // Sentry must be initialized before OTEL so it can instrument spans
    const { init, prismaIntegration } = await import('@sentry/nextjs');
    init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV,
      tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
      integrations: [prismaIntegration()],
    });

    // OpenTelemetry — only active when a collector endpoint is configured
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = await import('@opentelemetry/auto-instrumentations-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');

    const sdk = new NodeSDK({
      traceExporter: process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        ? new OTLPTraceExporter()
        : undefined,
      instrumentations: [getNodeAutoInstrumentations()],
    });
    sdk.start();
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    const { init } = await import('@sentry/nextjs');
    init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 0.2,
    });
  }
}

// Captures errors thrown in Server Components and server actions (Next.js 15+)
export async function onRequestError(err, request, context) {
  const { captureRequestError } = await import('@sentry/nextjs');
  await captureRequestError(err, request, context);
}
