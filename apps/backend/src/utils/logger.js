const winston = require('winston');

// Structured JSON format for production — Railway / any 12-factor PaaS parses
// stdout JSON into searchable fields (tenantId, jobId, etc).
const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

// Human-readable colorized format for local development.
const devFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.simple(),
);

// Console-only transport. Container PaaS platforms (Railway, Fly, Render, etc.)
// capture stdout; writing to files inside the container is invisible to
// operators and silently fills the ephemeral disk. We learned this the hard
// way — a previous version added File transports under NODE_ENV=production
// which caused combined.log to grow until it exhausted Railway's ~1GB
// ephemeral filesystem after ~2 days, after which Winston started swallowing
// every log call (no crash, no warning — just silence). If file logging is
// ever needed again, use a rotating transport (winston-daily-rotate-file)
// AND mount a persistent volume — never write unrotated to ephemeral disk.
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: jsonFormat,
  transports: [
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'production' ? jsonFormat : devFormat,
    }),
  ],
});

module.exports = logger;
