# Key Rotation

This is the operator runbook for rotating every secret Bliss owns: what
breaks while you're rotating it, the exact steps, how to verify it worked,
and how to roll back. You should not need to read application source to
follow it.

**Reference topology:** Docker Compose is Bliss's primary, officially
supported deployment, so every procedure below is written for it first. If
you instead run the split-cloud architecture from the
[Multi-Tenant Deployment](./multi-tenant-deployment) guide (web + API on
Vercel, backend worker on Railway), each section has a **Split-cloud
delta** callout with the extra step.

**Read this before rotating anything for the first time**, especially
[§2 `ENCRYPTION_SECRET`](#2-encryption_secret) — it is the one secret whose
failure mode is irreversible.

---

## §0. Before you start

### 0.1 Pre-flight checklist

Run through this before rotating *any* secret, not just `ENCRYPTION_SECRET`:

- [ ] **Database backup taken.** `pg_dump` (Docker Compose) or your managed
      Postgres provider's snapshot feature (Prisma Postgres / Railway /
      whichever you use). For `ENCRYPTION_SECRET` specifically, this is your
      only recovery path if something goes wrong after
      `ENCRYPTION_SECRET_PREVIOUS` has been removed.
- [ ] **Current `.env` archived** somewhere safe (password manager, encrypted
      note) — you'll want the old value on hand for rollback, and you should
      never have zero copies of a working `.env`.
- [ ] **Maintenance window chosen.** Every procedure except the optional
      zero-re-login JWT variant (§3.2) takes a short window (single-digit
      minutes) where something is briefly degraded. Pick a low-traffic time.
- [ ] **Rollback owner identified.** For a single-operator instance this is
      just "you, and you know the plan" — but write down who's driving before
      you start.
- [ ] **(Split-cloud only, first `ENCRYPTION_SECRET` rotation) Dry run on a
      throwaway preview.** Before your first *real* production
      `ENCRYPTION_SECRET` rotation, run the full §2 procedure once against a
      throwaway Vercel preview deployment + Railway preview environment
      pointed at a copy of your database (or a scratch database seeded with
      `seed-plaid-fixtures.mjs`). This is the only way to rehearse the
      split-cloud propagation ordering (§0.2) without risking production data.
      Not required for Docker Compose, and not required for every rotation —
      just the first one.

### 0.2 Split-cloud propagation

If you're on Docker Compose, skip this — `docker compose up` restarts
everything atomically enough that this doesn't apply.

If you're split-cloud, you have **two separate environment-variable stores**
(Vercel for web + API, Railway for the backend worker) and **two separate,
non-atomic redeploys**. Every section below tells you which store to update
first for that specific secret, but the general rule is:

> **Update the store that reads the value most defensively first, redeploy
> it, confirm it landed, then update the other store.**

For most secrets that means: reader/decrypter services first (so they can
already handle the new value or a dual-key window), then anything that
writes/produces with the new value. Expect a **~1–2 minute window** where
Vercel and Railway are running different versions of a secret — each
section states what "normal" looks like during that window.

**Confirming a redeploy landed**, for both platforms:

- **Vercel:** the deployment's dashboard shows the new commit/env fingerprint
  as "Ready", not "Building". `vercel env ls` shows the updated value.
- **Railway:** the service's "Deployments" tab shows the new deploy as
  "Active". Check the service logs for the `[env] ENCRYPTION_SECRET
  fingerprint: ...` startup line (§2) to confirm which key it actually
  loaded — this is more reliable than trusting the dashboard alone.

### 0.3 Verification catalogue

| Secret | How you know it worked |
|---|---|
| `ENCRYPTION_SECRET` | `node apps/api/scripts/verify-encryption-key.mjs` exits 0 and prints `undecryptable=0 insane=0` for every model. |
| `JWT_SECRET_CURRENT` / `NEXTAUTH_SECRET` | Sign in successfully with a fresh browser session after redeploy. |
| `INTERNAL_API_KEY` | API → backend calls succeed again (check backend logs for `401`s stopping, or trigger any `produceEvent()` action like a manual transaction edit). |
| `POSTGRES_PASSWORD` | Both `api` and `backend` connect on restart (no `P1000`/auth errors in logs); `GET /health` on the backend returns 200. |
| `REDIS_PASSWORD` | Backend `GET /health` returns 200 (it pings Redis); BullMQ jobs process again. |

### 0.4 Rollback catalogue

| Secret | Reversible? | Until when |
|---|---|---|
| `ENCRYPTION_SECRET` | Yes, until `verify-encryption-key.mjs` passes AND `ENCRYPTION_SECRET_PREVIOUS` is removed. After that, only a database restore can recover data encrypted under a key you've discarded. | Before `ENCRYPTION_SECRET_PREVIOUS` removal (§2.4). |
| `JWT_SECRET_CURRENT` | Yes, any time — restore the old value and redeploy. Users signed in during the bad window need to sign in again either way. | Always. |
| `NEXTAUTH_SECRET` | Yes, any time. | Always. |
| `INTERNAL_API_KEY` | Yes, any time. | Always. |
| `POSTGRES_PASSWORD` / `REDIS_PASSWORD` | Yes, any time — change it back at the engine and in the connection strings. | Always. |

### 0.5 Cleanup (every rotation)

- [ ] Remove any `*_PREVIOUS` value once you've confirmed you no longer need
      the fallback (immediately for `ENCRYPTION_SECRET` after verification;
      after the 24h TTL window if you used the optional JWT variant).
- [ ] Re-archive the updated `.env` (see 0.1).
- [ ] Confirm the new secret value isn't sitting in shell history
      (`history | grep`), a terminal scrollback you're about to screen-share,
      or CI logs (`echo`-ing a secret into a GitHub Actions log, for example).

---

## §1. Secret inventory

Every secret Bliss reads, where it lives, what breaks if it's wrong, and how
you recover. Cross-checked against `.env.example`,
`apps/api/utils/validateEnv.js`, and `apps/backend/src/utils/validateEnv.js`.

### Bliss-owned secrets

| Secret | Purpose | Read by | Docker `.env` | Vercel | Railway | If wrong | Recovery |
|---|---|---|---|---|---|---|---|
| `ENCRYPTION_SECRET` | AES-256-GCM key for data at rest (transaction descriptions, account numbers, Plaid tokens, user emails, `PlaidTransaction.rawJson`) | api, backend | ✅ | ✅ (api) | ✅ (backend) | Every encrypted field unreadable | **Irreversible** without the correct key — see §2 |
| `ENCRYPTION_SECRET_PREVIOUS` | Dual-key fallback during rotation | api, backend | ✅ (rotation only) | ✅ (rotation only) | ✅ (rotation only) | N/A — optional | N/A |
| `JWT_SECRET_CURRENT` | Signs session JWTs | api | ✅ | ✅ | — | Sign-in fails / all sessions invalid | Restart |
| `JWT_SECRET_PREVIOUS` | Optional zero-re-login fallback during JWT rotation | api | ✅ (rotation only) | ✅ (rotation only) | — | N/A — optional | N/A |
| `JWT_SECRET` | Legacy alias, still checked by `withAuth` after `JWT_SECRET_CURRENT`/`_PREVIOUS` | api | only if still set from an old install | only if still set | — | N/A if unset | Restart |
| `NEXTAUTH_SECRET` | NextAuth session encryption (Google sign-in flow) | api | ✅ | ✅ | — | In-flight Google sign-ins fail | Restart |
| `INTERNAL_API_KEY` | API ↔ backend auth header | api, backend | ✅ | ✅ (api) | ✅ (backend) | Internal calls 401 until both sides match | Restart |
| `POSTGRES_PASSWORD` | Database auth (embedded in `DATABASE_URL`) | api, backend | ✅ | ✅ (via `DATABASE_URL`) | ✅ (via `DATABASE_URL`) | Both services fail to connect | Restart |
| `REDIS_PASSWORD` | Queue/cache auth (embedded in `REDIS_URL`) | backend (api doesn't connect to Redis directly except via denylist checks) | ✅ | — | ✅ (via `REDIS_URL`) | Workers stop, JWT denylist fails open (warns, doesn't block) | Restart |

`POSTGRES_PASSWORD` / `REDIS_PASSWORD` aren't validated as standalone env
vars by either `validateEnv.js` — they only matter as the credential embedded
in `DATABASE_URL` / `REDIS_URL`, which *are* validated (`DATABASE_URL` is
required by both apps; `REDIS_URL` is required by the backend, optional-but-
warned by the api for JWT denylist).

### Third-party credentials (listed, not covered by this runbook)

These are rotated in the provider's own console. The mechanics are the
provider's concern — this table exists so §1's inventory is complete, per
AC1.

| Secret | Provider | Rotate in |
|---|---|---|
| `PLAID_SECRET` | Plaid | Plaid Dashboard → update env var → redeploy |
| `GEMINI_API_KEY` | Google AI Studio | Provider console → update env var → redeploy |
| `OPENAI_API_KEY` | OpenAI | Provider console → update env var → redeploy |
| `ANTHROPIC_API_KEY` | Anthropic | Provider console → update env var → redeploy |
| `TWELVE_DATA_API_KEY` | Twelve Data | Provider console → update env var → redeploy |
| `CURRENCYLAYER_API_KEY` | CurrencyLayer | Provider console → update env var → redeploy (legacy — only used when `CURRENCY_PROVIDER=CURRENCYLAYER`) |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console (OAuth) | Provider console → update env var → redeploy |

---

## §2. `ENCRYPTION_SECRET`

**What breaks during this:** email/password sign-in (and Google sign-in's
find-or-create lookup) is **down** for the few minutes the re-encryption
script is running, because `User.email` lookups are searchable-encrypted
with the *current* secret only (see 2.5). JWT-cookie sessions are
unaffected. This is the one procedure in this runbook that has an
irreversible failure mode if you skip a step — follow it in order.

### 2.1 The sequence

1. **Generate a new key:**
   ```bash
   openssl rand -base64 48 | tr -d '\n/+=' | head -c 48
   ```
   (Same recipe `scripts/setup.sh` uses for the initial value.)

2. **Set both env vars on every service:**
   `ENCRYPTION_SECRET=<new>`, `ENCRYPTION_SECRET_PREVIOUS=<old value you're
   replacing>`. Both api and backend need both values.

3. **Deploy/restart all services** so every reader can decrypt data
   encrypted under either key (`decrypt()` in `packages/shared/src/encryption.js`
   tries the current secret, then falls back to `ENCRYPTION_SECRET_PREVIOUS`).

   *Split-cloud delta:* update **Vercel (api) first**, redeploy, confirm it
   landed (§0.2) — the api is both a reader and, via searchable-email
   lookups, the thing most sensitive to a mismatch. Then update **Railway
   (backend)**, redeploy, confirm. Expect ~1–2 minutes where they're on
   different versions; during that window both still have the old key as
   their *primary* `ENCRYPTION_SECRET`, so nothing breaks yet — the dual-key
   window only starts mattering once you run the script in step 4.

4. **Run the re-encryption script**, immediately after all services confirm
   the dual-key deploy:
   ```bash
   ENCRYPTION_SECRET=<new> ENCRYPTION_SECRET_PREVIOUS=<old> \
     node apps/api/scripts/rotate-encryption-key.mjs
   ```
   Add `--dry-run` first if you want a preview — it reports what *would*
   change without writing anything. Run this against the shared database
   from one environment (your local machine, or one of the deployed
   services' shell) — it doesn't matter which, since all services already
   have both keys. Run it as soon as the dual-key deploy is confirmed: this
   is the window where email/password sign-in is degraded, so the faster you
   get through it, the shorter that window is.

5. **Run the verification gate** — this must print **0** before you touch
   `ENCRYPTION_SECRET_PREVIOUS`:
   ```bash
   ENCRYPTION_SECRET=<new> node apps/api/scripts/verify-encryption-key.mjs
   ```
   This scans `User.email`, `Account.accountNumber`,
   `Transaction.description`, `Transaction.details`, `PlaidItem.accessToken`,
   `RecurringCharge.merchantLabel`, and `PlaidTransaction.rawJson` — every
   field the rotation script touches — and confirms each decrypts under the
   **new key alone** (it never reads `ENCRYPTION_SECRET_PREVIOUS`, so it
   can't be fooled into passing while data is still on the old key). Exit
   code 0 and `undecryptable=0 insane=0` on every row means you're safe to
   continue. **Any other result: stop. Do not proceed to step 6.**
   Re-run step 4, then this step again.

6. **Remove `ENCRYPTION_SECRET_PREVIOUS`** from every service's environment.

7. **Deploy/restart all services again.**

   *Split-cloud delta:* same order as step 3 (Vercel first, then Railway),
   same confirmation approach.

8. **Re-run `verify-encryption-key.mjs` once more** post-cleanup as a final
   confirmation that everything is healthy with only the new key present.

### 2.2 Key-identity aid

Both `apps/api/instrumentation.js` and `apps/backend/src/index.js` log a line
at startup:

```
[env] ENCRYPTION_SECRET fingerprint: <16-char SHA-256 prefix>
```

This is a fingerprint, not the secret — safe to have in logs. Use it to
confirm which key a running service actually loaded, especially useful
during the split-cloud propagation window (§0.2) or if a redeploy seems to
not have picked up your change. `rotate-encryption-key.mjs` and
`verify-encryption-key.mjs` print the same fingerprint format for the keys
they're using, so you can cross-check.

### 2.3 Split-cloud delta (summary)

See step-by-step callouts in 2.1. Short version: api (Vercel) first at every
step, backend (Railway) second, confirm each via the fingerprint log line
before moving on. The whole rotation (steps 2–7) should take low
single-digit minutes on a typical self-hosted dataset; larger datasets take
longer at step 4/5 proportional to row count (both scripts batch in pages of
100–200 and print running totals).

### 2.4 Rollback

**Only possible while `ENCRYPTION_SECRET_PREVIOUS` is still set and step 5
(verification) has not yet passed.** If something looks wrong after step 4
but before step 5 passes:

1. Set `ENCRYPTION_SECRET` back to the **old** value on every service (leave
   `ENCRYPTION_SECRET_PREVIOUS` as-is, or clear it — it doesn't matter once
   `ENCRYPTION_SECRET` is the old value again).
2. Redeploy/restart.
3. Run `verify-encryption-key.mjs` with the old value — it should report 0
   undecryptable rows again, because `rotate-encryption-key.mjs` only
   re-encrypts fields that were still on the old key; anything it already
   migrated is now readable under **both** keys' `decrypt()` fallback until
   you retry, and the rows it touched are still valid ciphertext, just under
   the new key — which is why this rollback path requires
   `ENCRYPTION_SECRET_PREVIOUS` to still be configured somewhere reachable.

No manual database edits are required or supported. If you've already
completed step 6 (removed `ENCRYPTION_SECRET_PREVIOUS`) and something is
wrong, you are past the point of a clean rollback — restore from the backup
taken in §0.1.

### 2.5 Why sign-in breaks mid-rotation

`prisma/prisma.js`'s Prisma extension encrypts WHERE-clause lookups on
searchable fields (just `User.email` today) using the **current**
`ENCRYPTION_SECRET` only — not a dual-key attempt, because searchable
encryption needs a single deterministic ciphertext to match against. Once
you set the *new* key as `ENCRYPTION_SECRET` (step 2), a lookup by email will
only match rows already re-encrypted under the new key. Until step 4
finishes, that's rows on the old key too — so `findUnique({ where: { email }})`
misses them, and password/Google sign-in fails for users not yet migrated.
This is expected and is exactly why step 4 should run immediately after the
dual-key deploy is confirmed, and why the window should be as short as
practical. JWT-cookie sessions (already-signed-in users) are unaffected —
`decrypt()` still has its old-key fallback for reading the JWT-bound
`req.user` data.

### 2.6 Emergency (key compromised)

If `ENCRYPTION_SECRET` is confirmed leaked, skip the "pick a quiet window"
niceties in §0.1 and go straight to step 1 — the exposure clock is already
running. Everything else in the sequence stays the same; do not skip step 5
(verification) even under time pressure, since that's the step protecting
you from data loss.

---

## §3. Auth secrets — `JWT_SECRET_CURRENT` + `NEXTAUTH_SECRET`

**What breaks during this:** existing sessions are invalidated; users sign
in again. That's the whole user-visible impact — there's no data-loss risk
here.

### 3.1 Default path (both secrets, short window)

1. Generate new values the same way as any secret:
   ```bash
   openssl rand -base64 48 | tr -d '\n/+=' | head -c 48
   ```
2. Set the new `JWT_SECRET_CURRENT` and/or `NEXTAUTH_SECRET` on all services
   that read them (api only — see §1 inventory).
3. Redeploy.
4. Done. All previously issued JWTs and NextAuth session tokens stop
   validating; every user needs to sign in again once.

*Split-cloud delta:* only Vercel (api) — neither of these secrets is read by
the Railway backend. Redeploy once, confirm it landed (§0.2), no ordering
concern since there's only one store involved.

`signin.js`, `signup.js`, and `google-token.js` each capture
`JWT_SECRET_CURRENT || JWT_SECRET` **once, at module load** — so the signing
secret in use is fixed until the next redeploy/cold start; there's no
"stale signer" window to worry about mid-deploy the way there is with
`ENCRYPTION_SECRET`.

### 3.2 Optional: zero-re-login variant for `JWT_SECRET_CURRENT` only

If you'd rather not force everyone to sign in again, `JWT_SECRET` rotation
supports a dual-key fallback that `NEXTAUTH_SECRET` does not:

1. Set `JWT_SECRET_PREVIOUS` = current `JWT_SECRET_CURRENT` value.
2. Set `JWT_SECRET_CURRENT` = new value.
3. Redeploy. `withAuth.js` verifies incoming tokens against
   `[JWT_SECRET_CURRENT, JWT_SECRET, JWT_SECRET_PREVIOUS]` in order, so
   already-issued tokens (signed with the old secret) keep working via the
   `_PREVIOUS` fallback while newly issued tokens use the new secret.
4. **Wait out the token TTL — 24 hours** — so every previously issued token
   has naturally expired.
5. Remove `JWT_SECRET_PREVIOUS`. Redeploy.

This variant does **not** apply to `NEXTAUTH_SECRET` — there is no
`NEXTAUTH_SECRET_PREVIOUS` fallback in this codebase (by design; see PRD
scope decisions). Rotating `NEXTAUTH_SECRET` always uses the default path
above and always forces re-authentication for any in-flight Google sign-in.

Note the `JWT_SECRET` legacy alias: if your `.env` still has a bare
`JWT_SECRET` from an older install, `withAuth.js` checks it after
`JWT_SECRET_CURRENT` and before `JWT_SECRET_PREVIOUS`. New installs don't
set it — ignore this note if you don't have it.

### 3.3 Emergency (key compromised)

Compromised JWT secret means anyone with it can forge session tokens. Go
straight to §3.1 (the default, forced-re-login path) — do not use the
zero-re-login variant, since that deliberately keeps old-secret-signed
tokens valid for 24 hours, which is exactly what you don't want after a
leak.

---

## §4. Infra secrets — `INTERNAL_API_KEY`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`

**What breaks during this:** a short maintenance window per secret. BullMQ
jobs already queued are durable and retry/recover once the affected service
reconnects — they don't get lost. Fire-and-forget API→backend events
(`produceEvent()`, used for things like "a transaction changed, go
recalculate analytics") issued *during* the window are dropped after 3
retries over ~4 seconds and reported to Sentry rather than blocking the
request — they are not automatically replayed, but are effectively
re-triggered the next time the same data changes (e.g. the next edit to that
transaction, or the nightly revaluation cron). This is expected and
self-heals; it is not silent data loss.

### 4.1 `INTERNAL_API_KEY`

Stop → change → start, both services need to agree at all times (there's no
dual-accept):

1. Generate a new value:
   ```bash
   openssl rand -base64 32 | tr -d '\n/+=' | head -c 32
   ```
2. Set `INTERNAL_API_KEY` on **both** api and backend.
3. Restart both together (or as close together as your platform allows —
   during the gap, calls from whichever redeployed first will 401 against
   the one still on the old key; those calls retry/degrade as described
   above).
4. Confirm: trigger any action that produces an event (e.g. edit a
   transaction) and confirm it reaches the backend (no 401s in backend
   logs).

*Split-cloud delta:* update **Railway (backend) first**, redeploy, confirm
via logs that it's listening for the new key. Then update **Vercel (api)**,
redeploy. Rationale: the backend is the one validating the key
(`apiKeyAuth` middleware), so getting it onto the new value first minimizes
the window where a stale api is sending a key the backend already rejects
either way — either order has a brief mismatch window, but backend-first
means the mismatch produces a clear 401 you can watch for in one place
(backend logs) rather than swallowed api-side retries.

### 4.2 `POSTGRES_PASSWORD`

1. Generate a new value:
   ```bash
   openssl rand -base64 24 | tr -d '\n/+=' | head -c 24
   ```
2. **Docker Compose:** change `POSTGRES_PASSWORD` in `.env`, then
   `docker compose down && docker compose up -d` (Postgres re-reads its
   password from the env var on container recreation; existing data in the
   `postgres_data` volume is untouched). Update `DATABASE_URL` to embed the
   new password — both `api` and `backend` read the full connection string,
   not the bare password.
3. **Managed Postgres (split-cloud):** change the password from your
   provider's console (Prisma Postgres, or whichever host). Update
   `DATABASE_URL` on **both** Vercel and Railway to the new connection
   string. Redeploy both — order doesn't matter here since both are pure
   readers of the connection string; there's no dual-accept concern the way
   there is with `INTERNAL_API_KEY`, you simply can't connect with the old
   string once the provider has rotated it.
4. Restart/redeploy api and backend.
5. Confirm: `GET /health` on the backend returns 200; check api logs for
   successful Prisma connection (no `P1000`/authentication errors).

**Migration/seed on restart:** the api container runs `prisma migrate
deploy && node prisma/seed.js` on every boot (`docker/Dockerfile.api`
CMD) — this is idempotent and safe to run again during this restart, it
will not re-apply already-applied migrations or duplicate seed data.

*Split-cloud delta:* covered in step 3 above — this is the one infra secret
where the "change at the engine" step is itself a managed-provider console
action rather than a local `docker compose` command.

### 4.3 `REDIS_PASSWORD`

1. Generate a new value:
   ```bash
   openssl rand -base64 24 | tr -d '\n/+=' | head -c 24
   ```
2. **Docker Compose:** change `REDIS_PASSWORD` in `.env`, then
   `docker compose down && docker compose up -d`. Update `REDIS_URL` to
   embed the new password.
3. **Managed Redis (split-cloud, Railway):** rotate from Railway's Redis
   plugin/console. Update `REDIS_URL` on Railway (backend only — the api
   doesn't connect to Redis directly).
4. Restart/redeploy the backend.
5. Confirm: `GET /health` returns 200 (it pings Redis); watch backend logs
   for BullMQ workers reconnecting and resuming job processing.

*Split-cloud delta:* Railway only, single store, no ordering concern.

### 4.4 Emergency (any of the three compromised)

Same steps, just don't wait for a "good" maintenance window — the exposure
clock matters more than user-visible disruption for these three, since
their worst case is "briefly degraded, self-heals," not data loss.

---

## §5. Related reading

- [Maintenance](./maintenance.md) — what to do when data looks wrong (not a
  key-rotation concern, but often checked around the same time).
- [`docs/specs/api/12-deployment.md`](/docs/specs/api/12-deployment) —
  full api environment variable reference.
- [`docs/specs/backend/12-deployment-architecture.md`](/docs/specs/backend/12-deployment-architecture) —
  full deployment topology, including the Docker Compose and split-cloud
  PaaS paths this runbook assumes.
- [Multi-Tenant Deployment](./multi-tenant-deployment.md) — why the
  split-cloud Vercel + Railway architecture is recommended for hosting Bliss
  as a multi-user service, and its full topology.
