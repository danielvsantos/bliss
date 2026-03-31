#!/bin/sh
# Wait for PostgreSQL to accept connections before running migrations.
# Uses Node.js TCP check since Alpine doesn't have pg_isready or nc by default.
set -e

MAX_RETRIES=30
RETRY_INTERVAL=2

echo "Waiting for database to be ready..."

for i in $(seq 1 $MAX_RETRIES); do
  if node -e "
    const net = require('net');
    const url = new URL(process.env.DATABASE_URL);
    const socket = net.createConnection({
      host: url.hostname,
      port: url.port || 5432,
      timeout: 2000
    });
    socket.on('connect', () => { socket.destroy(); process.exit(0); });
    socket.on('error', () => process.exit(1));
    socket.on('timeout', () => { socket.destroy(); process.exit(1); });
  " 2>/dev/null; then
    echo "Database is ready (attempt $i)."
    exit 0
  fi
  echo "Database not ready yet (attempt $i/$MAX_RETRIES). Retrying in ${RETRY_INTERVAL}s..."
  sleep $RETRY_INTERVAL
done

echo "ERROR: Database did not become ready after $MAX_RETRIES attempts."
exit 1
