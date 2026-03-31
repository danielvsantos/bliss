# Bliss Frontend — Claude Code Instructions

## Design System — MANDATORY

All frontend components MUST use the Bliss design token system. **Never use raw Tailwind color utilities** (e.g., `green-500`, `amber-100`, `blue-700`, `red-600`) for semantic colors. Use the design tokens defined in `src/index.css` and mapped in `tailwind.config.ts` instead.

### Available Semantic Color Tokens

| Token | CSS Variable | Tailwind Class | Hex (Light) | Use For |
|-------|-------------|----------------|-------------|---------|
| **positive** | `--positive` | `text-positive`, `bg-positive`, `bg-positive/10` | #2E8B57 | Success, healthy, synced, approved |
| **negative** | `--negative` | `text-negative`, `bg-negative`, `bg-negative/10` | #E5989B | Negative amounts, losses |
| **warning** | `--warning` | `text-warning`, `bg-warning`, `bg-warning/10` | #E09F12 | Caution, attention required, pending |
| **destructive** | `--destructive` | `text-destructive`, `bg-destructive` | #E5989B | Errors, delete actions, critical |
| **brand-primary** | `--brand-primary` | `text-brand-primary`, `bg-brand-primary/10` | #6D657A | Brand accents, info badges |
| **brand-deep** | `--brand-deep` | `text-brand-deep`, `bg-brand-deep` | #3A3542 | Primary text, deep accents |
| **muted** | `--muted` | `text-muted-foreground`, `bg-muted` | #F1EEF5 | Disabled, inactive, manual |
| **primary** | `--primary` | `text-primary`, `bg-primary` | #3A3542 | Buttons, selected states |
| **accent** | `--accent` | `text-accent-foreground`, `bg-accent` | #EDE9F3 | Hover, subtle highlights |

### Badge Pattern

```tsx
// ✅ CORRECT — uses design tokens
<Badge className="bg-positive/10 text-positive border-positive/20">Success</Badge>
<Badge className="bg-warning/10 text-warning border-warning/20">Pending</Badge>
<Badge className="bg-brand-primary/10 text-brand-primary border-brand-primary/20">Info</Badge>
<Badge variant="destructive">Error</Badge>
<Badge variant="secondary">Manual</Badge>

// ❌ WRONG — never do this
<Badge className="bg-green-100 text-green-700">Success</Badge>
<Badge className="bg-amber-100 text-amber-700">Warning</Badge>
<Badge className="bg-blue-100 text-blue-700">Info</Badge>
```

### Opacity Variants for Light Backgrounds

Use `/10` or `/20` opacity suffix for light background tints derived from tokens:
- `bg-positive/10` — light green background
- `bg-warning/10` — light amber background
- `bg-destructive/10` — light rose background
- `border-positive/20` — subtle green border

### Status Indicator Colors

| Status | Text Class | Background | Dot/Indicator |
|--------|-----------|------------|---------------|
| Healthy / Synced | `text-positive` | `bg-positive/10` | `bg-positive` |
| Warning / Action Required | `text-warning` | `bg-warning/10` | `bg-warning` |
| Error / Critical | `text-destructive` | `bg-destructive/10` | `bg-destructive` |
| Disconnected / Manual | `text-muted-foreground` | `bg-muted` | `bg-muted-foreground` |

### Allowed Raw Tailwind Colors

The ONLY raw Tailwind colors permitted are:
- **Gray scale**: `gray-50` through `gray-900` — for structural elements (borders, dividers, backgrounds)
- **White/Black**: `white`, `black` — for absolute contrast needs
- **Inherit/Current**: `inherit`, `current` — for inheriting parent colors

Everything else (green, red, blue, amber, yellow, orange, indigo, etc.) MUST come from the design token system.

### Data-Viz Palette (Charts & Portfolio Groups)

For charts, portfolio category groups, and any data visualization that needs N distinct colors, use the `dataviz` tokens. These are mapped deterministically to category groups at runtime via `getGroupColor()` in `src/lib/portfolio-utils.ts`.

| Token | CSS Variable | Tailwind Class | Hex | Use For |
|-------|-------------|----------------|-----|---------|
| **dataviz-1** | `--dataviz-1` | `bg-dataviz-1`, `text-dataviz-1` | #6D657A | Default / brand-primary |
| **dataviz-2** | `--dataviz-2` | `bg-dataviz-2`, `text-dataviz-2` | #2E8B57 | Positive / green |
| **dataviz-3** | `--dataviz-3` | `bg-dataviz-3`, `text-dataviz-3` | #E09F12 | Warning / amber |
| **dataviz-4** | `--dataviz-4` | `bg-dataviz-4`, `text-dataviz-4` | #3A3542 | Brand-deep / dark plum |
| **dataviz-5** | `--dataviz-5` | `bg-dataviz-5`, `text-dataviz-5` | #3A8A8F | Teal |
| **dataviz-6** | `--dataviz-6` | `bg-dataviz-6`, `text-dataviz-6` | #B8AEC8 | Light purple |
| **dataviz-7** | `--dataviz-7` | `bg-dataviz-7`, `text-dataviz-7` | #7E7590 | Mid purple |
| **dataviz-8** | `--dataviz-8` | `bg-dataviz-8`, `text-dataviz-8` | #9A95A4 | Muted |

Debt groups always use negative-family colors (`#E5989B`, `#D4686C`, `#C44E52`, `#F0B4B6`) instead of the dataviz palette.

**Never hardcode hex colors for chart groups.** Use `buildGroupColorMap()` and `getGroupColor()` from `src/lib/portfolio-utils.ts` to assign colors dynamically based on the category groups present in the data.

### Portfolio Utilities (`src/lib/portfolio-utils.ts`)

| Function | Purpose |
|----------|---------|
| `parseDecimal(value)` | Safe Prisma Decimal → number conversion. Use instead of `parseFloat(x as any)`. |
| `getDisplayData(item, currency)` | Picks the correct financial summary (USD vs portfolio currency). |
| `getGroupColor(group, isDebt, index)` | Returns hex color for a category group. |
| `buildGroupColorMap(assetGroups, debtGroups)` | Builds a full `Record<string, string>` color map for all groups. |
| `getGroupIcon(group, processingHint?)` | Returns a Lucide icon for a category group. |

## UIKit Reference

The design system source of truth is at `Uikitforbliss/src/styles/theme.css`. When adding new semantic colors, add them to:
1. `bliss-frontend/src/index.css` — CSS variables (HSL format)
2. `bliss-frontend/tailwind.config.ts` — Tailwind color mapping
3. This file — documentation table above

## Component Patterns

- Use shadcn/ui components from `@/components/ui/`
- Use React Query (`@tanstack/react-query`) for server state
- Use `useToast()` from `@/hooks/use-toast` for notifications
- Always invalidate relevant React Query caches after mutations
