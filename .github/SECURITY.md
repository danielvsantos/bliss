# Security Policy

## Supported Versions

Only the latest release on the `main` branch receives security fixes. We do not backport patches to older versions.

| Version | Supported |
|---------|-----------|
| Latest (`main`) | Yes |
| Older releases | No |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, use [GitHub Private Security Advisories](https://github.com/danielvsantos/bliss/security/advisories/new) to report vulnerabilities. This creates a private channel where we can discuss the issue, develop a fix, and coordinate disclosure.

### What to include

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof of concept
- The version(s) affected
- Any suggested fix, if you have one

### What to expect

- **Acknowledgment** within 3 business days
- **Assessment and plan** within 7 business days
- **Fix and disclosure** timeline agreed upon collaboratively

We follow coordinated disclosure: the vulnerability will be made public only after a fix is available.

## Scope

The following are considered security issues:

- Authentication or authorization bypass
- Encryption weaknesses (AES-256-GCM implementation, key handling)
- SQL injection, XSS, or other injection attacks
- Exposure of sensitive data (transaction descriptions, account numbers, Plaid tokens)
- Multi-tenant data leakage (cross-tenant access)
- Server-side request forgery (SSRF)
- Vulnerabilities in dependencies that are exploitable in Bliss's context

The following are **not** in scope:

- Vulnerabilities that require physical access to the host machine
- Denial of service (Bliss is self-hosted; the operator controls access)
- Issues in third-party services (Plaid, Gemini, Twelve Data) — report those to the respective providers
- Security best practices that are already documented as user responsibility (e.g., setting strong secrets in `.env`)

## Security Architecture

Bliss is designed with security in mind:

- **Encryption at rest**: Transaction descriptions, account numbers, and Plaid access tokens are encrypted with AES-256-GCM via Prisma middleware
- **Multi-tenant isolation**: Every database query includes `tenantId` for strict query-level isolation
- **No analytics telemetry**: Bliss ships no usage analytics and makes no outbound call about how you use it. Error reporting is the one exception, and it is opt-in — see below.
- **Error reporting (opt-in)**: Bliss integrates with Sentry. With `SENTRY_DSN` unset — the default — the SDK is inert and nothing leaves your infrastructure. When you set `SENTRY_DSN`, exception events (message, stack trace, runtime metadata) are sent to the Sentry instance you configure. Those events pass through a scrubbing hook (`packages/shared/src/sentryScrub.js`) that removes HTTP client envelopes (`config`/`request`/`response`/`headers`) and denylisted keys such as `description`, `accountNumber`, `accessToken`, `authorization` and `x-api-key` before transmission. This matters because field encryption is Prisma middleware: a raw Prisma error carries *decrypted* values, so the hook — not the encryption layer — is what keeps them out of your error tracker. `sendDefaultPii` is left `false`.
- **Secret management**: All secrets are generated via `setup.sh` and stored in a local `.env` file. `ENCRYPTION_SECRET`, `JWT_SECRET_CURRENT`, `NEXTAUTH_SECRET` and `INTERNAL_API_KEY` must each be at least 32 characters; the API and backend refuse to boot in production otherwise.
