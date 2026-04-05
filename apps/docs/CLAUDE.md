# Bliss Docs Site

Public-facing documentation site for Bliss Finance, built with Nextra 4 on Next.js 15.

## Stack

| Detail | Value |
|--------|-------|
| Framework | Next.js 15 + Nextra 4 (App Router) |
| Port | 3002 |
| Module system | ESM (`"type": "module"`) |
| Styling | Tailwind CSS 3 + `@tailwindcss/typography` + Nextra theme |
| Font | Urbanist (Google Fonts) |

## Content Architecture

Content lives in `content/` and is a mix of auto-synced and hand-authored files.

### Critical Rule: Sync Script

**NEVER edit these files inside `apps/docs/content/`:**

- `architecture.md`
- `configuration.md`
- `guides/*.md` (all guide markdown files)

These are auto-synced from `docs/` at the monorepo root by `scripts/sync-docs.mjs`, which runs on every `predev` and `prebuild`. Your edits will be overwritten. **Edit the source files in `docs/` instead.**

### Adding Content

Guides are authored in `docs/guides/` (monorepo root) and synced to `content/guides/` on build. To add a new guide:

1. Create a `.md` file in `docs/guides/`
2. Add an entry to `content/guides/_meta.ts` to control sidebar title and ordering (this file stays in the docs app since it's Nextra-specific)

Top-level sidebar order is controlled by `content/_meta.ts`. Each `_meta.ts` export maps slugs to display titles (or config objects for layout overrides).

### Specs Manifest

The Specifications page is driven by `public/specs-manifest.json`, generated at build time by the sync script. Two maps in `scripts/sync-docs.mjs` control it:

- `FEATURE_MAP` -- defines feature slugs, display titles, descriptions, and sort order
- `LAYER_FILES` -- maps each feature slug to its spec filenames per layer (`api`, `backend`, `frontend`)

The manifest contains GitHub-relative paths so the UI can link to spec files in the repo. To add a new feature spec, add entries to both maps and ensure the corresponding files exist in `docs/specs/`.

## OpenAPI Reference

The API Reference page uses `@scalar/api-reference-react` to render interactive API docs from YAML files. OpenAPI specs are synced from `docs/openapi/*.yaml` into `public/openapi/` by the sync script.

To add a new API spec, place the YAML file in `docs/openapi/` (not directly in `public/openapi/`).

## Static Assets

- `public/images/` -- documentation images (screenshots, diagrams)
- `public/openapi/` -- auto-synced OpenAPI YAML files (do not edit directly)
- `public/specs-manifest.json` -- auto-generated (do not edit directly)

## Styling

Tailwind CSS with the same design token system as the main web app. Semantic color tokens (`brand-primary`, `brand-deep`, `positive`, `negative`, `warning`, etc.) are defined in `tailwind.config.ts` via CSS custom properties. Use tokens, not raw Tailwind colors.

Dark mode is supported via `next-themes` with class-based toggling (`darkMode: ["class"]`).
