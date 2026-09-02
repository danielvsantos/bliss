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

# ─── Optional services ────────────────────────────────────────────────────────

# Initialise all optional vars blank
GOOGLE_CLIENT_ID=""; GOOGLE_CLIENT_SECRET=""
PLAID_CLIENT_ID=""; PLAID_SECRET=""; PLAID_ENV="sandbox"; PLAID_WEBHOOK_URL=""
TWELVE_DATA_API_KEY=""
CURRENCYLAYER_API_KEY=""
CURRENCY_PROVIDER=""
SENTRY_DSN=""; SENTRY_ORG=""; SENTRY_PROJECT=""

# Track which services have been configured
CONFIGURED=""

configure_service() {
  local choice="$1"
  case "$choice" in
    1)
      echo "── Google OAuth ─────────────────────────────────────────────────"
      echo "   Create credentials at: console.cloud.google.com/apis/credentials"
      echo "   Authorized redirect URI: <NEXTAUTH_URL>/api/auth/callback/google"
      echo ""
      read -r -p "  GOOGLE_CLIENT_ID: " GOOGLE_CLIENT_ID
      read -r -p "  GOOGLE_CLIENT_SECRET: " GOOGLE_CLIENT_SECRET
      echo ""
      CONFIGURED="$CONFIGURED 1"
      ;;
    2)
      echo "── Plaid ────────────────────────────────────────────────────────"
      read -r -p "  PLAID_CLIENT_ID: " PLAID_CLIENT_ID
      read -r -p "  PLAID_SECRET: " PLAID_SECRET
      read -r -p "  PLAID_ENV [sandbox]: " _PLAID_ENV
      PLAID_ENV=${_PLAID_ENV:-sandbox}
      read -r -p "  PLAID_WEBHOOK_URL (leave blank if none): " PLAID_WEBHOOK_URL
      echo ""
      CONFIGURED="$CONFIGURED 2"
      ;;
    3)
      echo "── Twelve Data ──────────────────────────────────────────────────"
      echo "   Powers live stock/crypto prices, security fundamentals, AND"
      echo "   (by default) historical & current FX rates for multi-currency."
      read -r -p "  TWELVE_DATA_API_KEY: " TWELVE_DATA_API_KEY
      echo ""
      CONFIGURED="$CONFIGURED 3"
      ;;
    4)
      echo "── CurrencyLayer (legacy FX rates — optional) ───────────────────"
      echo "   Not needed if you configured Twelve Data above: it already"
      echo "   covers FX. Only set this to keep using the legacy CurrencyLayer"
      echo "   provider (CURRENCY_PROVIDER=CURRENCYLAYER)."
      read -r -p "  CURRENCYLAYER_API_KEY: " CURRENCYLAYER_API_KEY
      # If the operator supplies a CurrencyLayer key but no Twelve Data key,
      # pin the provider to CURRENCYLAYER so FX auto-fetch keeps working.
      if [ -n "$CURRENCYLAYER_API_KEY" ] && [ -z "$TWELVE_DATA_API_KEY" ]; then
        CURRENCY_PROVIDER="CURRENCYLAYER"
      fi
      echo ""
      CONFIGURED="$CONFIGURED 4"
      ;;
    5)
      echo "── Sentry ───────────────────────────────────────────────────────"
      read -r -p "  SENTRY_DSN: " SENTRY_DSN
      read -r -p "  SENTRY_ORG: " SENTRY_ORG
      read -r -p "  SENTRY_PROJECT: " SENTRY_PROJECT
      echo ""
      CONFIGURED="$CONFIGURED 5"
      ;;
  esac
}

print_services_menu() {
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  Optional Services                                           ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  [[ "$CONFIGURED" != *" 1"* ]] && echo "  1) Google OAuth    — enables Sign in with Google"
  [[ "$CONFIGURED" != *" 2"* ]] && echo "  2) Plaid           — bank connection & real-time transaction sync"
  [[ "$CONFIGURED" != *" 3"* ]] && echo "  3) Twelve Data     — live stock prices, security fundamentals & FX rates"
  [[ "$CONFIGURED" != *" 4"* ]] && echo "  4) CurrencyLayer   — legacy FX rates (optional; Twelve Data covers FX by default)"
  [[ "$CONFIGURED" != *" 5"* ]] && echo "  5) Sentry          — error monitoring & alerting"
  echo ""
}

while true; do
  print_services_menu
  read -r -p "Enter a number to configure, or press Enter to continue: " OPT_CHOICE
  echo ""
  [ -z "$OPT_CHOICE" ] && break
  case "$OPT_CHOICE" in
    1|2|3|4|5) configure_service "$OPT_CHOICE" ;;
    *) echo "  Invalid choice, please enter a number from the list above." ; echo "" ;;
  esac
done

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
sed -i.bak -e "s|^LLM_PROVIDER=.*|LLM_PROVIDER=$LLM_PROVIDER|" "$ENV_FILE"

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

# ─── Inject optional service credentials ─────────────────────────────────────
[ -n "$GOOGLE_CLIENT_ID" ]     && sed -i.bak -e "s|^GOOGLE_CLIENT_ID=.*|GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID|" "$ENV_FILE"
[ -n "$GOOGLE_CLIENT_SECRET" ] && sed -i.bak -e "s|^GOOGLE_CLIENT_SECRET=.*|GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET|" "$ENV_FILE"
[ -n "$PLAID_CLIENT_ID" ]      && sed -i.bak -e "s|^PLAID_CLIENT_ID=.*|PLAID_CLIENT_ID=$PLAID_CLIENT_ID|" "$ENV_FILE"
[ -n "$PLAID_SECRET" ]         && sed -i.bak -e "s|^PLAID_SECRET=.*|PLAID_SECRET=$PLAID_SECRET|" "$ENV_FILE"
sed -i.bak -e "s|^PLAID_ENV=.*|PLAID_ENV=$PLAID_ENV|" "$ENV_FILE"
[ -n "$PLAID_WEBHOOK_URL" ]    && sed -i.bak -e "s|^PLAID_WEBHOOK_URL=.*|PLAID_WEBHOOK_URL=$PLAID_WEBHOOK_URL|" "$ENV_FILE"
[ -n "$TWELVE_DATA_API_KEY" ]  && sed -i.bak -e "s|^TWELVE_DATA_API_KEY=.*|TWELVE_DATA_API_KEY=$TWELVE_DATA_API_KEY|" "$ENV_FILE"
[ -n "$CURRENCYLAYER_API_KEY" ] && sed -i.bak -e "s|^CURRENCYLAYER_API_KEY=.*|CURRENCYLAYER_API_KEY=$CURRENCYLAYER_API_KEY|" "$ENV_FILE"
[ -n "$CURRENCY_PROVIDER" ]    && sed -i.bak -e "s|^CURRENCY_PROVIDER=.*|CURRENCY_PROVIDER=$CURRENCY_PROVIDER|" "$ENV_FILE"
[ -n "$SENTRY_DSN" ]           && sed -i.bak -e "s|^SENTRY_DSN=.*|SENTRY_DSN=$SENTRY_DSN|" "$ENV_FILE"
[ -n "$SENTRY_ORG" ]           && sed -i.bak -e "s|^SENTRY_ORG=.*|SENTRY_ORG=$SENTRY_ORG|" "$ENV_FILE"
[ -n "$SENTRY_PROJECT" ]       && sed -i.bak -e "s|^SENTRY_PROJECT=.*|SENTRY_PROJECT=$SENTRY_PROJECT|" "$ENV_FILE"

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
echo "  1. docker compose up --build"
echo "  2. Open http://localhost:8080"
