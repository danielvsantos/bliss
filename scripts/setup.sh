#!/usr/bin/env bash
# Bliss Finance — local development setup
# Generates secrets and creates .env from .env.example
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ENV_FILE="$ROOT/.env"
EXAMPLE_FILE="$ROOT/.env.example"

if [ -f "$ENV_FILE" ]; then
  echo "⚠  .env already exists. Delete it first if you want to regenerate."
  exit 1
fi

echo "Generating secrets..."
ENCRYPTION_SECRET=$(openssl rand -base64 48 | tr -d '\n/+=' | head -c 48)
JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n/+=' | head -c 48)
NEXTAUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n/+=' | head -c 48)
INTERNAL_API_KEY=$(openssl rand -base64 32 | tr -d '\n/+=' | head -c 32)
POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '\n/+=' | head -c 24)
REDIS_PASSWORD=$(openssl rand -base64 24 | tr -d '\n/+=' | head -c 24)

cp "$EXAMPLE_FILE" "$ENV_FILE"

sed -i.bak \
  -e "s|ENCRYPTION_SECRET=replace-with-output-of-scripts-setup-sh|ENCRYPTION_SECRET=$ENCRYPTION_SECRET|" \
  -e "s|JWT_SECRET_CURRENT=replace-with-output-of-scripts-setup-sh|JWT_SECRET_CURRENT=$JWT_SECRET|" \
  -e "s|NEXTAUTH_SECRET=replace-with-output-of-scripts-setup-sh|NEXTAUTH_SECRET=$NEXTAUTH_SECRET|" \
  -e "s|INTERNAL_API_KEY=replace-with-output-of-scripts-setup-sh|INTERNAL_API_KEY=$INTERNAL_API_KEY|" \
  -e "s|POSTGRES_PASSWORD=changeme|POSTGRES_PASSWORD=$POSTGRES_PASSWORD|" \
  -e "s|REDIS_PASSWORD=changeme|REDIS_PASSWORD=$REDIS_PASSWORD|" \
  -e "s|postgresql://bliss:changeme@|postgresql://bliss:$POSTGRES_PASSWORD@|" \
  -e "s|redis://:changeme@|redis://:$REDIS_PASSWORD@|" \
  "$ENV_FILE"

rm -f "$ENV_FILE.bak"

echo ""
echo "✓ .env created with generated secrets."
echo ""
echo "Next steps:"
echo "  1. Add your optional API keys to .env (Plaid, Gemini, Sentry)"
echo "  2. docker compose up --build"
echo "  3. Open http://localhost:8080"
