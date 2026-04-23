const Sentry = require('@sentry/node');

// Sentry must be initialized before any other imports that create spans
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
  integrations: [Sentry.prismaIntegration()],
});

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const app = express();

// Security headers
app.use(helmet());

// CORS — only allow requests from the known API layer origin(s).
// Server-to-server calls from Next.js API routes don't send an Origin header,
// so they pass through regardless. This blocks browser-based probing of the
// backend URL from unknown origins.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // No origin = server-to-server call (curl, Node fetch, etc.) — allow
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin '${origin}' not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-KEY'],
}));

// Explicit body size limit — prevents memory exhaustion via large payloads
app.use(express.json({ limit: '50kb' }));

// API Routes
app.use('/api/events', require('./routes/events'));
app.use('/api/feedback', require('./routes/feedback'));
app.use('/api/similar', require('./routes/similar'));
app.use('/api/pricing', require('./routes/pricing'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/admin/rebuild', require('./routes/rebuild'));
app.use('/api/ticker', require('./routes/ticker'));
app.use('/api/security-master', require('./routes/securityMaster'));
app.use('/api/insights', require('./routes/insights'));

// Health Check Endpoint — pings Redis to detect degraded state
app.get('/health', async (req, res) => {
  const uptime = process.uptime();
  try {
    const { getRedisConnection } = require('./utils/redis');
    const redis = getRedisConnection();
    await redis.ping();
    res.status(200).json({ status: 'ok', redis: 'connected', uptime });
  } catch {
    res.status(503).json({ status: 'degraded', redis: 'disconnected', uptime });
  }
});

// Health Metrics — cache stats for monitoring
app.get('/health/metrics', (req, res) => {
  const { getCacheStats: getDescStats } = require('./utils/descriptionCache');
  const { getCacheStats: getCatStats } = require('./utils/categoryCache');
  res.json({
    descriptionCache: getDescStats(),
    categoryCache: getCatStats(),
    uptime: process.uptime(),
  });
});

// Sentry error handler — must come after routes, before any other error handlers
Sentry.setupExpressErrorHandler(app);

module.exports = app;
