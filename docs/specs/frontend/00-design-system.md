# 0. Bliss Design System

> **"Calm. Precise. Deliberate."**
>
> A premium, globally-minded design system built for sophisticated financial products. Every color, spacing value, and radius is intentional — never arbitrary.

---

## Source of Truth

| Layer | File | Role |
|-------|------|------|
| **UIKit definition** | `Uikitforbliss/src/styles/theme.css` | Canonical token values (hex format) |
| **UIKit page** | `Uikitforbliss/src/app/pages/DesignSystem.tsx` | Visual reference — rendered swatches, type scale, components |
| **Production CSS** | `bliss-frontend/src/index.css` | Token values in HSL format (Tailwind-compatible) |
| **Tailwind mapping** | `bliss-frontend/tailwind.config.ts` | Maps CSS vars → Tailwind utility classes |
| **Usage rules** | `bliss-frontend/CLAUDE.md` | Enforcement rules for Claude Code sessions |

---

## 1. Color System

### Design Philosophy
The Bliss palette is built around a **muted purple-gray core** with **semantic accents** for financial signals. It avoids bright primaries in favour of calm, sophisticated tones that convey trust and precision.

**Financial signal colors (`positive`, `negative`, `warning`) do NOT change between light and dark mode.** They are intentionally stable — green always means gain, rose always means loss, amber always means caution, regardless of theme.

### Color Tokens — Complete Reference

| Token Name | CSS Variable | Tailwind Class | Hex Value | Use For |
|-----------|-------------|----------------|-----------|---------|
| **background** | `--background` | `bg-background` | #FAFAFA | Page canvas, app background |
| **foreground** | `--foreground` | `text-foreground` | #1A1625 | Primary text, headings |
| **brand-primary** | `--brand-primary` | `text-brand-primary`, `bg-brand-primary` | #6D657A | Secondary buttons, info badges, accents |
| **brand-deep** | `--brand-deep` | `text-brand-deep`, `bg-brand-deep` | #3A3542 | Primary buttons, active states, strong emphasis |
| **positive** | `--positive` | `text-positive`, `bg-positive` | #2E8B57 | Success, gains, synced, confirmed, up-trends |
| **negative** | `--negative` | `text-negative`, `bg-negative` | #E5989B | Losses, declines, **negative financial amounts** — not errors |
| **warning** | `--warning` | `text-warning`, `bg-warning` | #E09F12 | Caution, attention required, pending action |
| **destructive** | `--destructive` | `text-destructive`, `bg-destructive` | #E5989B | **Error states, delete actions, critical failures** — not financial amounts |
| **muted** | `--muted` | `bg-muted` | #F1EEF5 | Disabled states, subtle backgrounds |
| **muted-foreground** | `--muted-foreground` | `text-muted-foreground` | #9A95A4 | Secondary text, labels, placeholders |
| **accent** | `--accent` | `bg-accent` | #EDE9F3 | Hover backgrounds, row highlights |
| **border** | `--border` | `border-border` | #E2E8F0 | Input borders, dividers, card borders (shadcn default) |
| **input-background** | `--input-background` | `bg-input-background` | #F5F3F8 | Input field backgrounds |
| **ring** | `--ring` | `ring-ring` | #6D657A | Focus rings (keyboard navigation) |
| **card** | `--card` | `bg-card` | rgba(255,255,255,0.72) | Card backgrounds (translucent in UIKit; opaque white in production) |

### `negative` vs `destructive` — Critical Distinction

These two tokens share the same hex value (`#E5989B`) but carry different **semantic intent** and should never be swapped:

| Token | When to use |
|-------|------------|
| `negative` | A financial signal — negative amounts, losses, down-trends. No action implied. |
| `destructive` | An action consequence — deleting, breaking, erroring. Use on buttons, error banners, toasts. |

### Chart Colors

Used exclusively for data visualization. Do not use for UI states.

| Token | Tailwind | Hex | Role |
|-------|----------|-----|------|
| `--chart-1` | `text-chart-1` | #6D657A | Brand primary series |
| `--chart-2` | `text-chart-2` | #2E8B57 | Positive / growth series |
| `--chart-3` | `text-chart-3` | #E5989B | Negative / loss series |
| `--chart-4` | `text-chart-4` | #A09AB0 | Neutral / comparison series |
| `--chart-5` | `text-chart-5` | #3A3542 | Deep / secondary series |

### Sidebar Tokens

Used only in sidebar layout components. Not for general UI.

| Token | Tailwind | Use |
|-------|----------|-----|
| `--sidebar-background` | `bg-sidebar` | Sidebar panel background (#F5F3F8) |
| `--sidebar-foreground` | `text-sidebar-foreground` | Sidebar text (#3A3542) |
| `--sidebar-accent` | `bg-sidebar-accent` | Nav item hover background |
| `--sidebar-border` | `border-sidebar-border` | Sidebar right border |

### Dark Mode

Dark mode is enabled via the `.dark` class on the `<html>` element. Most tokens automatically invert:
- Background: `#FAFAFA` → `#1A1625` (deep plum)
- Cards: `rgba(255,255,255,0.72)` → `rgba(42, 37, 54, 0.78)` (translucent dark purple)
- Borders: `#E2E8F0` → `rgba(255, 255, 255, 0.1)` (subtle white overlay)
- Text: `#1A1625` → `#F0EDF5` (pale lavender)
- `muted`: `#F1EEF5` → `#2E2840`

**Exception — financial signal colors do NOT change in dark mode:**
`positive`, `negative`, `warning`, `destructive` — identical in both themes.

**Never hardcode light-mode hex values** in JSX — always use CSS variable tokens so dark mode works automatically.

---

## 2. Token Naming Notes

The codebase has some legacy aliasing that can cause confusion:

| Preferred | Alias (legacy) | Notes |
|-----------|---------------|-------|
| `text-muted-foreground` | `text-muted-fg` | Both map to `#9A95A4`. Always use `text-muted-foreground`. |
| `border-border` | `border-border-color` | Both map to `#E2E8F0`. Always use `border-border` (shadcn default). |
| `bg-secondary` | — | In UIKit: `transparent`. In production CSS: `white`. Use `bg-muted` for subtle backgrounds instead of `bg-secondary`. |

---

## 3. Mandatory Color Rules

### ❌ NEVER do this

```tsx
// Raw Tailwind colors — FORBIDDEN
<Badge className="bg-green-100 text-green-700 border-green-200">Synced</Badge>
<span className="text-amber-600">Warning</span>
<div className="bg-red-500">Error</div>
<div className="text-blue-700">Info</div>

// Hardcoded hex in className — FORBIDDEN
<span className="text-[#2E8B57]">Synced</span>
<div className="bg-[#3A3542]">Button</div>
```

### ✅ ALWAYS do this

```tsx
// Design token classes — REQUIRED
<Badge className="bg-positive/10 text-positive border-positive/20">Synced</Badge>
<span className="text-warning">Warning</span>
<div className="bg-destructive">Error</div>
<Badge className="bg-brand-primary/10 text-brand-primary border-brand-primary/20">Info</Badge>
```

### Allowed raw Tailwind colors

Only these categories of raw Tailwind utilities are permitted:
- **Structural grays**: `gray-50` through `gray-900` — for borders/dividers (prefer `border-border` instead)
- **White / Black**: for absolute contrast needs only
- **Opacity utilities**: `/10`, `/20`, `/50` etc. on *design token* classes (e.g. `bg-positive/10`)

---

## 4. Semantic Color Usage Guide

### Status & Connection States

| Status | Badge Classes | Dot Color | Text Color |
|--------|-------------|-----------|------------|
| Synced / Healthy / Active | `bg-positive/10 text-positive border-positive/20` | `bg-positive` | `text-positive` |
| Action Required / Warning | `bg-warning/10 text-warning border-warning/20` | `bg-warning` | `text-warning` |
| Error / Critical | `bg-destructive/10 text-destructive border-destructive/20` | `bg-destructive` | `text-destructive` |
| Disconnected / Inactive / Manual | `bg-muted text-muted-foreground border-border` | `bg-muted-foreground` | `text-muted-foreground` |
| Info / Connected | `bg-brand-primary/10 text-brand-primary border-brand-primary/20` | `bg-brand-primary` | `text-brand-primary` |

### Financial Amounts

| Signal | Color | Tailwind |
|--------|-------|----------|
| Positive amount / gain | Green | `text-positive` |
| Negative amount / loss | Rose | `text-negative` |
| Neutral / zero | Muted | `text-muted-foreground` |

### Confidence / Score Thresholds

For numeric confidence or score displays (e.g. AI confidence percentage):

| Threshold | Token |
|-----------|-------|
| High (≥ 80%) | `text-positive` |
| Medium (≥ 50%) | `text-warning` |
| Low (< 50%) | `text-destructive` |

---

## 5. Badge Pattern

The standard badge pattern uses a `bg-{color}/10 text-{color} border-{color}/20` combination to create a light tinted background derived from the semantic color.

```tsx
// Pattern reference
<Badge className="bg-{token}/10 text-{token} border-{token}/20 hover:bg-{token}/10">
  Label
</Badge>

// Real examples
<Badge className="bg-positive/10 text-positive border-positive/20 hover:bg-positive/10">
  Synced
</Badge>

<Badge className="bg-warning/10 text-warning border-warning/20 hover:bg-warning/10">
  Action Required
</Badge>

<Badge className="bg-brand-primary/10 text-brand-primary border-brand-primary/20 hover:bg-brand-primary/10">
  Plaid Connected
</Badge>

// For error/destructive — use the shadcn variant instead
<Badge variant="destructive">Failed</Badge>

// For inactive/manual — use the shadcn variant
<Badge variant="secondary">Manual</Badge>
```

---

## 6. Typography

### Font Family

**Urbanist** — Geometric humanist. Imported from Google Fonts at all weights 400–700.

```html
<!-- Already imported globally in index.css -->
@import url('https://fonts.google.com/css2?family=Urbanist:wght@400;500;600;700');
```

Use via Tailwind: `font-sans` (already set as default in `tailwind.config.ts`).

### Type Scale

| Role | Size | Weight | Letter Spacing | Tailwind | Usage |
|------|------|--------|----------------|----------|-------|
| **Display / H1** | 2rem (32px) | 600 | -0.03em | `text-4xl font-semibold tracking-tight` | Page titles |
| **H2** | 1.5rem (24px) | 600 | 0em | `text-2xl font-semibold` | Section headers |
| **H3** | 1.125rem (18px) | 500 | +0.01em | `text-lg font-medium` | Subheadings |
| **H4** | 1rem (16px) | 500 | +0.01em | `text-base font-medium` | Card titles |
| **Body** | 0.9375rem (15px) | 400 | 0em | `text-[15px]` | Paragraph text |
| **Label** | 0.875rem (14px) | 500 | 0em | `text-sm font-medium` | Input labels, table headers |
| **Small** | 0.875rem (14px) | 400 | 0em | `text-sm` | Secondary text, captions |
| **Micro** | 0.75rem (12px) | 400 | 0em | `text-xs` | Timestamps, metadata, badges |

---

## 7. Spacing System

All spacing follows a **4pt grid** (Tailwind's default `rem`-based scale maps to this).

| Tailwind | px | Typical use |
|----------|----|-------------|
| `p-1` / `gap-1` | 4px | Micro gaps, icon padding |
| `p-2` / `gap-2` | 8px | Tight internal spacing |
| `p-3` / `gap-3` | 12px | Small component padding |
| `p-4` / `gap-4` | 16px | Default card padding |
| `p-6` / `gap-6` | 24px | Section spacing |
| `p-8` / `gap-8` | 32px | Large layout spacing |
| `p-12` | 48px | Major section breaks |

---

## 8. Border Radius

All radius values use the `--radius` CSS variable (`0.75rem` / 12px) as the base.

| Token | Size | Tailwind | Typical use |
|-------|------|----------|-------------|
| `radius-sm` | 8px | `rounded-sm` | Tight elements (badges, small chips) |
| `radius-md` | 10px | `rounded-md` | Inputs, small buttons |
| `radius-lg` | 12px | `rounded-lg` | Cards, modals (default) |
| `rounded-xl` | 16px | `rounded-xl` | Large containers |
| `rounded-full` | 9999px | `rounded-full` | Avatars, pill badges, dots |

---

## 9. Component Patterns

### Cards

Standard cards use shadcn's `<Card>` component from `@/components/ui/card`. For elevated "liquid glass" effect use the `.glass-card` utility class:

```css
/* Defined in index.css */
.glass-card {
  background: rgba(255, 255, 255, 0.68);
  backdrop-filter: blur(20px) saturate(1.6);
  border: 1px solid #E2E8F0;
  box-shadow: 0 1px 2px ..., 0 4px 12px ..., inset 0 1px 0 rgba(255,255,255,0.9);
  border-radius: 12px;
}
```

Note: `.glass-card` uses raw hex for the border and background. This is intentional — it's defined at the CSS layer, not in JSX.

### Buttons

Always use shadcn `<Button>` from `@/components/ui/button` — **never** use `src/components/button.tsx` (legacy component with hardcoded hex, pending refactor).

| Variant | Background | Text | Use |
|---------|------------|------|-----|
| `default` | `primary` (#3A3542) | white | Primary CTA |
| `outline` | transparent | `primary` | Secondary actions |
| `ghost` | transparent | `primary` | Minimal / icon actions |
| `destructive` | `destructive` | white | Delete / danger actions |
| `secondary` | transparent → muted on hover | `primary` | Tertiary / inactive |

### Focus States

All interactive elements use the ring system. Applied automatically by shadcn components.

```css
/* Manual focus ring utility */
.bliss-focus-ring:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--ring-offset), 0 0 0 4px var(--ring);
}
```

---

## 10. Adding a New Design Token

When a new semantic color or value is needed, update **all three layers** in order:

### Step 1 — UIKit (source of truth)
Edit `Uikitforbliss/src/styles/theme.css`:
```css
/* Accents */
--positive: #2E8B57;
--my-new-token: #HEXVALUE;   /* ← add here with comment */
```

### Step 2 — Production CSS
Edit `bliss-frontend/src/index.css` (HSL format):
```css
--positive: 147 50% 36%;
--my-new-token: H S% L%;   /* ← HSL equivalent */
```

### Step 3 — Tailwind mapping
Edit `bliss-frontend/tailwind.config.ts`:
```ts
colors: {
  positive: "hsl(var(--positive))",
  "my-new-token": "hsl(var(--my-new-token))",   // ← add here
}
```

### Step 4 — Document it here
Add a row to the **Color Tokens** table in this file.

---

## 11. What Is NOT in the Design System

The Bliss design system intentionally excludes some common UI patterns:

- **No amber/yellow from Tailwind** — use `warning` token (#E09F12) instead
- **No blue** — Plaid "Connected" badges use `brand-primary` (purple), not blue
- **No orange or indigo** — not part of the palette
- **No `green-*` Tailwind classes** — use `positive` token
- **No `red-*` Tailwind classes** — use `destructive` or `negative` token
- **No hardcoded hex in JSX** — always use CSS variable-backed tokens

---

## 12. Implementation Status

### ✅ Fully compliant — all files verified clean (audited 2026-03-03)

- `src/components/ui/*` — all shadcn/ui primitives use tokens correctly
- `src/components/review/group-card.tsx` — `text-positive`, `text-muted-foreground`, `hover:bg-muted/30`
- `src/components/review/status-badge.tsx` — all four variants use `bg-{token}/10 text-{token} border-{token}/20`
- `src/components/review/confidence-display.tsx` — ternary uses `text-positive`, `text-warning`, `text-destructive`
- `src/components/review/tx-data-row.tsx` — amounts use `text-positive`/`text-negative`; action buttons use token classes
- `src/components/review/merchant-history.tsx` — amount display uses `text-positive`/`text-negative`
- `src/components/review/deep-dive-drawer.tsx` — amounts and warning callout use design tokens
- `src/components/review/investment-enrichment-form.tsx` — warning callout uses `text-warning`
- `src/components/button.tsx` — all variants refactored to token classes (`bg-primary`, `bg-positive`, `bg-destructive/10`, etc.)
- `src/components/account-selection-modal.tsx` — Plaid confirmation UI uses `text-positive`, `bg-positive/5`, `border-positive/20`
- `src/components/entities/bank-form.tsx` — uses `bg-foreground text-background`
- `src/components/accounts/account-list-panel.tsx` — status badges correct
- `src/components/accounts/connection-health.tsx` — health dots and text correct
- `src/components/accounts/account-detail-panel.tsx` — Plaid badge, shield icon correct
- `src/components/accounts/sync-logs-table.tsx` — success/failure pills correct
- `src/components/layout/Sidebar.tsx` — uses `hsl(var(--*))` inline styles (correct intent, non-Tailwind pattern)
- `src/pages/transactions.tsx` — amount colors use `text-positive`/`text-negative`
- `src/pages/transaction-review.tsx` — status indicators use design tokens
- `src/pages/reports/portfolio.tsx` — all gain/loss displays use `text-positive`/`text-negative`
- `src/pages/smart-import.tsx` — all badges and confidence indicators use token classes
- `src/pages/settings/index.tsx` — AI threshold warning uses `bg-warning/10 text-warning border-warning/20`; Danger Zone uses `border-destructive/30 text-destructive`
- `src/pages/settings/users.tsx` — role badges and status indicators use design tokens

### Exempt (do not modify)

- `src/components/ui/toast.tsx` — contains `text-red-300`, `text-red-50`, `focus:ring-red-400` inside the shadcn-generated destructive toast variant. Accept as-is.

### Re-audit command

Run this at any time to confirm zero violations:

```bash
grep -rn \
  "text-green-\|bg-green-\|text-red-\|bg-red-\|text-amber-\|bg-amber-\|text-blue-\|bg-blue-\|text-yellow-\|bg-yellow-\|text-\[#\|bg-\[#" \
  src/ --include="*.tsx" \
  | grep -v "src/components/ui/toast.tsx"
```

Zero output means full compliance.
