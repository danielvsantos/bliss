const winston = require('winston');

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Create the logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Add file transport in production
if (process.env.NODE_ENV === 'production') {
  logger.add(
    new winston.transports.File({ 
      filename: 'error.log', 
      level: 'error',
      format: logFormat
    })
  );
  logger.add(
    new winston.transports.File({ 
      filename: 'combined.log',
      format: logFormat
    })
  );
}

module.exports = logger; 