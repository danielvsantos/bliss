#!/usr/bin/env bash
# Bliss — local development setup
# Generates secrets, prompts for AI provider configuration, and creates .env
# from .env.example.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ENV_FILE="$ROOT/.env"
EXAMPLE_FILE="$ROOT/.env.example"

if [ -f "$ENV_FILE" ]; then
  echo "⚠  .env already exists. Delete it first if you want to regenerate."
  exit 1
fi

# ─── AI provider configuration (REQUIRED) ────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  AI Provider Setup (REQUIRED)                                ║"
echo "║                                                              ║"
echo "║  Bliss depends on an LLM for transaction classification and  ║"
echo "║  financial insights. Pick the provider you want to use.      ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  1) Google Gemini    (recommended — native embedding support)"
echo "  2) OpenAI           (native embedding support via text-embedding-3-small)"
echo "  3) Anthropic Claude (requires a secondary provider for embeddings)"
echo ""
read -r -p "Choice [1]: " LLM_CHOICE
LLM_CHOICE=${LLM_CHOICE:-1}

case "$LLM_CHOICE" in
  1) LLM_PROVIDER="gemini";    KEY_VAR="GEMINI_API_KEY" ;;
  2) LLM_PROVIDER="openai";    KEY_VAR="OPENAI_API_KEY" ;;
  3) LLM_PROVIDER="anthropic"; KEY_VAR="ANTHROPIC_API_KEY" ;;
  *) echo "Invalid choice: $LLM_CHOICE"; exit 1 ;;
esac

echo ""
read -r -p "Paste your $KEY_VAR (or leave blank to configure later): " LLM_API_KEY
echo ""

# Anthropic requires a secondary embedding provider
EMBEDDING_PROVIDER=""
EMB_KEY_VAR=""
EMB_API_KEY=""
if [ "$LLM_PROVIDER" = "anthropic" ]; then
  echo "Anthropic does not provide an embedding API. Bliss needs one of these"
  echo "to build the vector index for transaction similarity:"
  echo ""
  echo "  1) Google Gemini"
  echo "  2) OpenAI"
  echo ""
  read -r -p "Embedding provider [1]: " EMB_CHOICE
  EMB_CHOICE=${EMB_CHOICE:-1}
  case "$EMB_CHOICE" in
    1) EMBEDDING_PROVIDER="gemini"; EMB_KEY_VAR="GEMINI_API_KEY" ;;
    2) EMBEDDING_PROVIDER="openai"; EMB_KEY_VAR="OPENAI_API_KEY" ;;
    *) echo "Invalid choice: $EMB_CHOICE"; exit 1 ;;
  esac
  echo ""
  read -r -p "Paste your $EMB_KEY_VAR: " EMB_API_KEY
  echo ""
fi

# ─── Generate secrets ────────────────────────────────────────────────────────
echo "Generating secrets..."
ENCRYPTION_SECRET=$(openssl rand -base64 48 | tr -d '\n/+=' | head -c 48)
JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n/+=' | head -c 48)
NEXTAUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n/+=' | head -c 48)
INTERNAL_API_KEY=$(openssl rand -base64 32 | tr -d '\n/+=' | head -c 32)
POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '\n/+=' | head -c 24)
REDIS_PASSWORD=$(openssl rand -base64 24 | tr -d '\n/+=' | head -c 24)

cp "$EXAMPLE_FILE" "$ENV_FILE"

# ─── Inject secrets ──────────────────────────────────────────────────────────
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

# ─── Inject LLM provider configuration ───────────────────────────────────────
# LLM_PROVIDER (default in .env.example is "gemini")
sed -i.bak -e "s|^LLM_PROVIDER=.*|LLM_PROVIDER=$LLM_PROVIDER|" "$ENV_FILE"

# Primary provider API key
if [ -n "$LLM_API_KEY" ]; then
  sed -i.bak -e "s|^$KEY_VAR=.*|$KEY_VAR=$LLM_API_KEY|" "$ENV_FILE"
fi

# Embedding provider (only set when different from primary, i.e. Anthropic path)
if [ -n "$EMBEDDING_PROVIDER" ]; then
  sed -i.bak -e "s|^EMBEDDING_PROVIDER=.*|EMBEDDING_PROVIDER=$EMBEDDING_PROVIDER|" "$ENV_FILE"
  if [ -n "$EMB_API_KEY" ]; then
    sed -i.bak -e "s|^$EMB_KEY_VAR=.*|$EMB_KEY_VAR=$EMB_API_KEY|" "$ENV_FILE"
  fi
fi

rm -f "$ENV_FILE.bak"

# ─── Done ────────────────────────────────────────────────────────────────────
echo ""
echo "✓ .env created."
echo "    LLM_PROVIDER=$LLM_PROVIDER"
if [ -n "$EMBEDDING_PROVIDER" ]; then
  echo "    EMBEDDING_PROVIDER=$EMBEDDING_PROVIDER"
fi
if [ -z "$LLM_API_KEY" ]; then
  echo "    (⚠  $KEY_VAR is blank — add your key to .env before starting)"
fi
if [ "$LLM_PROVIDER" = "anthropic" ] && [ -z "$EMB_API_KEY" ]; then
  echo "    (⚠  $EMB_KEY_VAR is blank — add your key to .env before starting)"
fi
echo ""
echo "Next steps:"
echo "  1. (optional) Add other API keys to .env: Plaid, TwelveData, CurrencyLayer, Sentry"
echo "  2. docker compose up --build"
echo "  3. Open http://localhost:8080"
