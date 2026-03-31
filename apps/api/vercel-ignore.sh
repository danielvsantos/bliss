#!/bin/bash
# Vercel Ignored Build Step for apps/api
# https://vercel.com/docs/projects/overview#ignored-build-step
#
# Exit 1 = proceed with build
# Exit 0 = skip build

echo "Checking if apps/api needs a rebuild..."

# Always rebuild on main branch
if [ "$VERCEL_GIT_COMMIT_REF" = "main" ]; then
  echo "✓ Main branch — building."
  exit 1
fi

# Check if relevant files changed since last successful deployment
git diff HEAD^ HEAD --quiet \
  apps/api/ \
  packages/shared/ \
  prisma/ \
  package.json \
  pnpm-lock.yaml

if [ $? -eq 1 ]; then
  echo "✓ Relevant files changed — building."
  exit 1
else
  echo "✗ No relevant changes — skipping build."
  exit 0
fi
