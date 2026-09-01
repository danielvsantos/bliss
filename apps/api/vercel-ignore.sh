#!/bin/bash
# Vercel Ignored Build Step for apps/api
# https://vercel.com/docs/projects/overview#ignored-build-step
#
# Exit 1 = proceed with build
# Exit 0 = skip build
#
# Fail-open: if we cannot reliably determine what changed (shallow clone with no
# parent, missing diff base, git error), we BUILD rather than skip. A wasted
# build is cheap; a silently skipped one serves a stale/placeholder preview.

echo "Checking if apps/api needs a rebuild..."

# Always rebuild on main branch
if [ "$VERCEL_GIT_COMMIT_REF" = "main" ]; then
  echo "✓ Main branch — building."
  exit 1
fi

# Vercel checks out a shallow clone, so HEAD^ often does not exist. Try to
# deepen it enough to get a diff base; ignore failure (guarded below).
git fetch --deepen=20 >/dev/null 2>&1 || true

# Prefer the SHA of this project's last successful deployment on this branch;
# fall back to the previous commit.
BASE="${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}"

if ! git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null 2>&1; then
  echo "✓ No usable diff base (${BASE}) — building to be safe."
  exit 1
fi

# --quiet: exit 0 if no diff, 1 if diff, 128 on error. The if/else treats any
# non-zero (diff OR error) as "build".
if git diff --quiet "${BASE}" HEAD -- \
  apps/api/ \
  packages/shared/ \
  prisma/ \
  package.json \
  pnpm-lock.yaml; then
  echo "✗ No relevant changes — skipping build."
  exit 0
else
  echo "✓ Relevant files changed (or diff unavailable) — building."
  exit 1
fi
