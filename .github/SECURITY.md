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
- **No telemetry**: No data leaves your infrastructure
- **Secret management**: All secrets are generated via `setup.sh` and stored in a local `.env` file
