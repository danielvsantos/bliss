# Key Rotation

This is the operator runbook for rotating every secret Bliss owns: what
breaks while you're rotating it, the exact steps, how to verify it worked,
and how to roll back. You should not need to read application source to
follow it.

**Reference topology:** Docker Compose is Bliss's primary, officially
supported deployment, so every procedure below is written for it first. If
you instead run the single-Railway-project architecture from the
[Multi-Tenant Deployment](/docs/guides/multi-tenant-deployment) guide (web,
API, backend, Postgres, and Redis all in one Railway project, on its private
network), each section has a **Railway note** callout with the extra step —
it's the same procedure, just applied to each Railway service in turn
instead of one `docker compose` restart.

**Read this before rotating anything for the first time**, especially the
[ENCRYPTION_SECRET section](#encryption_secret) below — it is the one
secret whose failure mode is irreversible.

---

## Before you start

### Pre-flight checklist

Run through this before rotating *any* secret, not just `ENCRYPTION_SECRET`:

- [ ] **Database backup taken.** `pg_dump` (Docker Compose, or Railway's
      Postgres plugin). For `ENCRYPTION_SECRET` specifically, this is your
      only recovery path if something goes wrong after
      `ENCRYPTION_SECRET_PREVIOUS` has been removed.
- [ ] **Current `.env` archived** somewhere safe (password manager, encrypted
      note) — you'll want the old value on hand for rollback, and you should
      never have zero copies of a working `.env`.
- [ ] **Maintenance window chosen.** The auth and infra secrets below are
      restart-based and take low single-digit minutes regardless of data
      size — except the optional zero-re-login JWT variant, which trades
      that for a 24h wait instead. `ENCRYPTION_SECRET` is different: its
      window scales with row count (see the timing note under
      [ENCRYPTION_SECRET](#encryption_secret) below) — get a real number
      from your pre-flight dry run before picking a window length for that
      one. Pick a low-traffic time either way.
- [ ] **Rollback owner identified.** For a single-operator instance this is
      just "you, and you know the plan" — but write down who's driving before
      you start.
- [ ] **(Railway, first `ENCRYPTION_SECRET` rotation) Dry run on a cloned
      environment.** Before your first production `ENCRYPTION_SECRET`
      rotation, duplicate your Railway environment (see Multi-Tenant
      Deployment's ["Staging environments"](/docs/guides/multi-tenant-deployment#staging-environments))
      and run the full [ENCRYPTION_SECRET procedure](#encryption_secret)
      there against a scratch database seeded with `seed-plaid-fixtures.mjs`
      (or a `pg_dump` copy of production). This is the only way to rehearse
      the [multi-service redeploy ordering](#multi-service-redeploy-ordering)
      without risking production data. Not required for Docker Compose, and
      not required for every rotation — just the first one.

### Multi-service redeploy ordering

If you're on Docker Compose, skip this — `docker compose up` restarts
everything atomically enough that this doesn't apply.

If you're on Railway, `api`, `backend`, `web`, Postgres, and Redis are all in
one project, but they're still **independent services that redeploy on their
own schedule** — changing a service's variables doesn't restart the whole
project atomically, and there's no cross-service "deploy all" button. Every
section below tells you which service to redeploy first for that specific
secret, but the general rule is:

> **Redeploy the service that reads the value most defensively first,
> confirm it landed, then redeploy the rest.**

For most secrets that means: reader/decrypter services first (so they can
already handle the new value or a dual-key window), then anything that
writes/produces with the new value. Expect a brief window — usually under a
minute — where two services are running different versions of a secret;
each section states what "normal" looks like during that window.

**Confirming a redeploy landed:** the service's "Deployments" tab in the
Railway dashboard shows the new deploy as "Active". Check the service's logs
for the `[env] ENCRYPTION_SECRET fingerprint: ...` startup line (see
[ENCRYPTION_SECRET](#encryption_secret)) to confirm which key it actually
loaded — this is more reliable than trusting the dashboard alone, since a
deploy can show "Active" before you're sure it picked up the variable you
just changed.

### Verification catalogue

| Secret | How you know it worked |
|---|---|
| `ENCRYPTION_SECRET` | `node apps/api/scripts/verify-encryption-key.mjs` exits 0 and prints `undecryptable=0 insane=0` for every model. |
| `JWT_SECRET_CURRENT` / `NEXTAUTH_SECRET` | Sign in successfully with a fresh browser session after redeploy. |
| `INTERNAL_API_KEY` | API → backend calls succeed again (check backend logs for `401`s stopping, or trigger any `produceEvent()` action like a manual transaction edit). |
| `POSTGRES_PASSWORD` | Both `api` and `backend` connect on restart (no `P1000`/auth errors in logs); `GET /health` on the backend returns 200. |
| `REDIS_PASSWORD` | Backend `GET /health` returns 200 (it pings Redis); BullMQ jobs process again. |

### Rollback catalogue

| Secret | Reversible? | Until when |
|---|---|---|
| `ENCRYPTION_SECRET` | Yes, until `verify-encryption-key.mjs` passes AND `ENCRYPTION_SECRET_PREVIOUS` is removed. After that, only a database restore can recover data encrypted under a key you've discarded. | Before `ENCRYPTION_SECRET_PREVIOUS` removal (see [Rollback](#rollback)). |
| `JWT_SECRET_CURRENT` | Yes, any time — restore the old value and redeploy. Users signed in during the bad window need to sign in again either way. | Always. |
| `NEXTAUTH_SECRET` | Yes, any time. | Always. |
| `INTERNAL_API_KEY` | Yes, any time. | Always. |
| `POSTGRES_PASSWORD` / `REDIS_PASSWORD` | Yes, any time — change it back at the engine and redeploy the services that reference it. | Always. |

### Cleanup (every rotation)

- [ ] Remove any `*_PREVIOUS` value once you've confirmed you no longer need
      the fallback (immediately for `ENCRYPTION_SECRET` after verification;
      after the 24h TTL window if you used the optional JWT variant).
- [ ] Re-archive the updated `.env` (see the pre-flight checklist above).
- [ ] Confirm the new secret value isn't sitting in shell history
      (`history | grep`), a terminal scrollback you're about to screen-share,
      or CI logs (`echo`-ing a secret into a GitHub Actions log, for example).

---

## Secret inventory

Every secret Bliss reads, where it lives, what breaks if it's wrong, and how
you recover. Cross-checked against `.env.example`,
`apps/api/utils/validateEnv.js`, and `apps/backend/src/utils/validateEnv.js`.

### Bliss-owned secrets

| Secret | Purpose | Read by | Docker `.env` | Railway | If wrong | Recovery |
|---|---|---|---|---|---|---|
| `ENCRYPTION_SECRET` | AES-256-GCM key for data at rest (transaction descriptions, account numbers, Plaid tokens, user emails, `PlaidTransaction.rawJson`) | api, backend | ✅ | ✅ (api + backend) | Every encrypted field unreadable | **Irreversible** without the correct key — see [ENCRYPTION_SECRET](#encryption_secret) below |
| `ENCRYPTION_SECRET_PREVIOUS` | Dual-key fallback during rotation | api, backend | ✅ (rotation only) | ✅ (rotation only) | N/A — optional | N/A |
| `JWT_SECRET_CURRENT` | Signs session JWTs | api | ✅ | ✅ (api only) | Sign-in fails / all sessions invalid | Restart |
| `JWT_SECRET_PREVIOUS` | Optional zero-re-login fallback during JWT rotation | api | ✅ (rotation only) | ✅ (rotation only) | N/A — optional | N/A |
| `JWT_SECRET` | Legacy alias, still checked by `withAuth` after `JWT_SECRET_CURRENT`/`_PREVIOUS` | api | only if still set from an old install | only if still set | N/A if unset | Restart |
| `NEXTAUTH_SECRET` | NextAuth session encryption (Google sign-in flow) | api | ✅ | ✅ (api only) | In-flight Google sign-ins fail | Restart |
| `INTERNAL_API_KEY` | API ↔ backend auth header | api, backend | ✅ | ✅ (api + backend) | Internal calls 401 until both sides match | Restart |
| `POSTGRES_PASSWORD` | Database auth (embedded in `DATABASE_URL`) | api, backend | ✅ | Set on Railway's Postgres plugin; `api`/`backend` reference it via `${{Postgres.DATABASE_URL}}` | Both services fail to connect | Restart |
| `REDIS_PASSWORD` | Queue/cache auth (embedded in `REDIS_URL`) | backend (api doesn't connect to Redis directly except via denylist checks) | ✅ | Set on Railway's Redis plugin; `backend` references it via `${{Redis.REDIS_URL}}` | Workers stop, JWT denylist fails open (warns, doesn't block) | Restart |

`POSTGRES_PASSWORD` / `REDIS_PASSWORD` aren't validated as standalone env
vars by either `validateEnv.js` — they only matter as the credential embedded
in `DATABASE_URL` / `REDIS_URL`, which *are* validated (`DATABASE_URL` is
required by both apps; `REDIS_URL` is required by the backend, optional-but-
warned by the api for JWT denylist).

### Third-party credentials (listed, not covered by this runbook)

These are rotated in the provider's own console. The mechanics are the
provider's concern — this table exists so the inventory above is complete.

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

## ENCRYPTION_SECRET

**What breaks during this:** email/password sign-in (and Google sign-in's
find-or-create lookup) is **down** for the few minutes the re-encryption
script is running, because `User.email` lookups are searchable-encrypted
with the *current* secret only (see "Why sign-in breaks mid-rotation"
below). JWT-cookie sessions are unaffected. This is the one procedure in
this runbook that has an irreversible failure mode if you skip a step —
follow it in order.

### The sequence

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

   *Railway note:* redeploy **api first**, confirm it landed (see
   [Multi-service redeploy ordering](#multi-service-redeploy-ordering)) —
   it's both a reader and, via searchable-email lookups, the service most
   sensitive to a mismatch. Then redeploy **backend**, confirm. Expect well
   under a minute where they're on different versions; during that window
   both still have the old key as their *primary* `ENCRYPTION_SECRET`, so
   nothing breaks yet — the dual-key window only starts mattering once you
   run the script in step 4.

4. **Run the re-encryption script**, immediately after all services confirm
   the dual-key deploy:
   ```bash
   ENCRYPTION_SECRET=<new> ENCRYPTION_SECRET_PREVIOUS=<old> \
     node apps/api/scripts/rotate-encryption-key.mjs
   ```
   Add `--dry-run` first if you want a preview — it reports what *would*
   change without writing anything. Run it as soon as the dual-key deploy is
   confirmed: this is the window where email/password sign-in is degraded,
   so the faster you get through it, the shorter that window is.

   **Where to run it:** inside the api service, not from your laptop.
   Postgres is on the private network only (see the [inventory](#secret-inventory)
   above) — there's no need to open it up or point a local connection
   string at it.

   - **Docker Compose:** `docker compose exec api sh`, then run the command
     above from inside the container (it already has `ENCRYPTION_SECRET`
     and `ENCRYPTION_SECRET_PREVIOUS` from step 2's `.env` change).
   - **Railway:** `railway ssh --service api --environment <env> -- node apps/api/scripts/rotate-encryption-key.mjs`
     (add `--dry-run` the same way). This opens an SSH session into the
     running container over Railway's own network — nothing touches your
     machine except the terminal output. The api service already has both
     keys from step 3, so no extra env vars are needed on the command line.
     `railway ssh --service api --environment <env>` with no trailing
     command instead drops you into an interactive shell if you'd rather
     run the steps one at a time and look around first.

5. **Run the verification gate** — this must print **0** before you touch
   `ENCRYPTION_SECRET_PREVIOUS`:
   ```bash
   ENCRYPTION_SECRET=<new> node apps/api/scripts/verify-encryption-key.mjs
   ```
   Same place as step 4 (`docker compose exec api sh`, or
   `railway ssh --service api --environment <env> -- node apps/api/scripts/verify-encryption-key.mjs`)
   — the api service already has `ENCRYPTION_SECRET` set to the new value,
   so the inline prefix above is only needed if you're running it somewhere
   that doesn't already have it in its environment.

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

   *Railway note:* same order as step 3 (api first, then backend), same
   confirmation approach.

8. **Re-run `verify-encryption-key.mjs` once more** post-cleanup as a final
   confirmation that everything is healthy with only the new key present.

### Key-identity aid

Both `apps/api/instrumentation.js` and `apps/backend/src/index.js` log a line
at startup:

```
[env] ENCRYPTION_SECRET fingerprint: <16-char SHA-256 prefix>
```

This is a fingerprint, not the secret — safe to have in logs. Use it to
confirm which key a running service actually loaded, especially useful
during the multi-service redeploy window (see [above](#multi-service-redeploy-ordering))
or if a redeploy seems to not have picked up your change.
`rotate-encryption-key.mjs` and `verify-encryption-key.mjs` print the same
fingerprint format for the keys they're using, so you can cross-check.

### Railway note (summary)

See the step-by-step callouts in "The sequence" above. Short version:
redeploy api first at every step, backend second, confirm each via the
fingerprint log line before moving on — both live in the same Railway
project, so this is two quick redeploys from one dashboard, not two separate
platforms.

**Timing is data-dependent — don't assume "a few minutes."** Steps 4 and 5
do real per-row cryptographic work (PBKDF2, 100k iterations per field), and
both scripts run it concurrently (`ROTATION_CONCURRENCY`, default 16, capped
by the service's actual CPU allocation — see the scripts' own headers) to
keep this from being a purely sequential, single-threaded scan. Even so, at
tens of thousands of rows this is a real number to know in advance, not
assume: on a small dataset it's low single-digit minutes; at 30,000+
Transaction rows plus thousands of Plaid transactions, expect somewhere in
the 15–30 minute range for a first-ever rotation (step 4) — less on repeat
runs, since already-migrated fields are skipped — plus a few more minutes
per `verify-encryption-key.mjs` pass (step 5, and again in step 8). **Get
your own number from the [pre-flight dry run](#pre-flight-checklist)** on a
copy of your real row counts before you schedule the maintenance window,
rather than
trusting this range — CPU allocation varies by Railway plan, and Postgres
round-trip latency adds on top of the derivation cost.

### Rollback

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
taken in the [pre-flight checklist](#pre-flight-checklist).

### Why sign-in breaks mid-rotation

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

### Emergency: ENCRYPTION_SECRET compromised

If `ENCRYPTION_SECRET` is confirmed leaked, skip the "pick a quiet window"
niceties in the [pre-flight checklist](#pre-flight-checklist) and go
straight to step 1 — the exposure clock is already running. Everything else
in the sequence stays the same; do not skip step 5 (verification) even
under time pressure, since that's the step protecting you from data loss.

---

## Auth secrets — JWT_SECRET_CURRENT + NEXTAUTH_SECRET

**What breaks during this:** existing sessions are invalidated; users sign
in again. That's the whole user-visible impact — there's no data-loss risk
here.

### Default path

Covers both secrets and takes a short window:

1. Generate new values the same way as any secret:
   ```bash
   openssl rand -base64 48 | tr -d '\n/+=' | head -c 48
   ```
2. Set the new `JWT_SECRET_CURRENT` and/or `NEXTAUTH_SECRET` on all services
   that read them (api only — see the [inventory](#secret-inventory) above).
3. Redeploy.
4. Done. All previously issued JWTs and NextAuth session tokens stop
   validating; every user needs to sign in again once.

*Railway note:* only the api service reads these — redeploy just that one
service; the backend needs no change, so there's no ordering concern.

`signin.js`, `signup.js`, and `google-token.js` each capture
`JWT_SECRET_CURRENT || JWT_SECRET` **once, at module load** — so the signing
secret in use is fixed until the next redeploy/cold start; there's no
"stale signer" window to worry about mid-deploy the way there is with
`ENCRYPTION_SECRET`.

### Optional: zero-re-login variant for JWT_SECRET_CURRENT only

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

### Emergency: JWT secret compromised

Compromised JWT secret means anyone with it can forge session tokens. Go
straight to the [Default path](#default-path) above (the forced-re-login
path) — do not use the zero-re-login variant, since that deliberately keeps
old-secret-signed tokens valid for 24 hours, which is exactly what you don't
want after a leak.

---

## Infra secrets — INTERNAL_API_KEY, POSTGRES_PASSWORD, REDIS_PASSWORD

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

### INTERNAL_API_KEY

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

*Railway note:* redeploy **backend first**, confirm via logs that it's
listening for the new key. Then redeploy **api**. Rationale: the backend is
the one validating the key (`apiKeyAuth` middleware), so getting it onto the
new value first minimizes the window where a stale api is sending a key the
backend already rejects either way — either order has a brief mismatch
window, but backend-first means the mismatch produces a clear 401 you can
watch for in one place (backend logs) rather than swallowed api-side
retries. Since both services are in the same project, this is two quick
redeploys back to back, not a cross-platform coordination problem.

### POSTGRES_PASSWORD

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
3. **Railway:** rotate the password from the Postgres plugin's own settings
   (regenerate credentials, or set a new one directly). Because `api` and
   `backend` reference the connection string as `${{Postgres.DATABASE_URL}}`
   rather than a copy-pasted value (see [Multi-Tenant Deployment](/docs/guides/multi-tenant-deployment)),
   you don't need to manually update `DATABASE_URL` in two places — redeploy
   `api` and `backend` so each resolves the new value. Order doesn't matter
   here: both are pure readers of the connection string, and there's no
   dual-accept concern the way there is with `INTERNAL_API_KEY` — you simply
   can't connect with the old string once the plugin has rotated it.
4. Restart/redeploy api and backend.
5. Confirm: `GET /health` on the backend returns 200; check api logs for
   successful Prisma connection (no `P1000`/authentication errors).

**Migration/seed on restart:** the api container runs `prisma migrate
deploy && node prisma/seed.js` on every boot (`docker/Dockerfile.api`
CMD) — this is idempotent and safe to run again during this restart, it
will not re-apply already-applied migrations or duplicate seed data.

### REDIS_PASSWORD

1. Generate a new value:
   ```bash
   openssl rand -base64 24 | tr -d '\n/+=' | head -c 24
   ```
2. **Docker Compose:** change `REDIS_PASSWORD` in `.env`, then
   `docker compose down && docker compose up -d`. Update `REDIS_URL` to
   embed the new password.
3. **Railway:** rotate from the Redis plugin's own settings. `backend`
   references it as `${{Redis.REDIS_URL}}` (see [Multi-Tenant Deployment](/docs/guides/multi-tenant-deployment)),
   so — same as `POSTGRES_PASSWORD` — you don't manually copy a connection
   string anywhere; just redeploy `backend` so it resolves the new value.
   `api` doesn't connect to Redis directly, so it needs no change.
4. Restart/redeploy the backend.
5. Confirm: `GET /health` returns 200 (it pings Redis); watch backend logs
   for BullMQ workers reconnecting and resuming job processing.

### Emergency: infra secret compromised

Same steps for whichever of the three is compromised — just don't wait for
a "good" maintenance window. The exposure clock matters more than
user-visible disruption for these three, since their worst case is "briefly
degraded, self-heals," not data loss.

---

## Next steps

- [Maintenance](/docs/guides/maintenance) — what to do when data looks
  wrong (not a key-rotation concern, but often checked around the same
  time).
- [Multi-Tenant Deployment](/docs/guides/multi-tenant-deployment) — the
  current, authoritative reference for the single-Railway-project
  production topology this runbook's Railway notes assume: private
  networking, `${{service.VAR}}` references, and staging environments.
- [`docs/specs/api/12-deployment.md`](/docs/specs/api/12-deployment) — api
  environment variable reference (the Docker Compose path; some of its
  PaaS-specific notes predate the current Railway topology above).
