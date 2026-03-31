import {
  TrendingUp,
  Coins,
  DollarSign,
  Home,
  Car,
  Paintbrush,
  Landmark,
  HelpCircle,
  Building,
  CreditCard,
  GraduationCap,
  type LucideIcon,
} from "lucide-react";

// ── Data-viz hex palette (must stay in sync with --dataviz-* in index.css) ──

const DATAVIZ_HEX = [
  "#6D657A", // dataviz-1 brand-primary
  "#2E8B57", // dataviz-2 positive/green
  "#E09F12", // dataviz-3 warning/amber
  "#3A3542", // dataviz-4 brand-deep
  "#3A8A8F", // dataviz-5 teal
  "#B8AEC8", // dataviz-6 light purple
  "#7E7590", // dataviz-7 mid purple
  "#9A95A4", // dataviz-8 muted
];

// Debt uses negative-family colors with slight variation per group
const DEBT_HEX = [
  "#E5989B", // negative (primary debt color)
  "#D4686C", // darker rose
  "#C44E52", // deeper rose
  "#F0B4B6", // light rose
];

// ── getGroupColor ──────────────────────────────────────────────────────────

/**
 * Returns a deterministic hex color for a category group.
 * Debt groups get negative-family colors; asset groups cycle through the dataviz palette.
 * `index` should be the group's position in a stable-sorted list of all groups.
 */
export function getGroupColor(
  group: string,
  isDebt: boolean,
  index: number
): string {
  if (isDebt) {
    return DEBT_HEX[index % DEBT_HEX.length];
  }
  return DATAVIZ_HEX[index % DATAVIZ_HEX.length];
}

/**
 * Builds a color map for all groups present in portfolio data.
 * Groups are sorted alphabetically for deterministic assignment.
 */
export function buildGroupColorMap(
  assetGroups: string[],
  debtGroups: Set<string>
): Record<string, string> {
  const map: Record<string, string> = {};

  const sortedAssetGroups = [...assetGroups]
    .filter((g) => !debtGroups.has(g))
    .sort();
  const sortedDebtGroups = [...debtGroups].sort();

  sortedAssetGroups.forEach((group, i) => {
    map[group] = getGroupColor(group, false, i);
  });

  sortedDebtGroups.forEach((group, i) => {
    map[group] = getGroupColor(group, true, i);
  });

  return map;
}

// ── getGroupIcon ───────────────────────────────────────────────────────────

const HINT_ICON_MAP: Record<string, LucideIcon> = {
  API_STOCK: TrendingUp,
  API_FUND: TrendingUp,
  API_CRYPTO: Coins,
  CASH: DollarSign,
  AMORTIZING_LOAN: Home,
  SIMPLE_LIABILITY: CreditCard,
  MANUAL: Building,
};

const GROUP_ICON_MAP: Record<string, LucideIcon> = {
  Cash: DollarSign,
  "Real Estate": Home,
  Crypto: Coins,
  Auto: Car,
  Collectibles: Paintbrush,
  Bonds: Landmark,
  "Pension Plan": Building,
  Stocks: TrendingUp,
  Funds: TrendingUp,
  ETFs: TrendingUp,
  "Credit Card Debt": CreditCard,
  "Student Loan": GraduationCap,
  Mortgage: Home,
};

/**
 * Returns a Lucide icon component for the given category group.
 * Prioritizes processingHint mapping, then group name, then default.
 */
export function getGroupIcon(
  group: string,
  processingHint?: string
): LucideIcon {
  if (processingHint && HINT_ICON_MAP[processingHint]) {
    return HINT_ICON_MAP[processingHint];
  }
  return GROUP_ICON_MAP[group] || HelpCircle;
}

// ── parseDecimal ───────────────────────────────────────────────────────────

/**
 * Safely converts a Prisma Decimal / string / number / null to a plain number.
 * Replaces all `parseFloat(value as any)` patterns.
 */
export function parseDecimal(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return parseFloat(value) || 0;
  // Prisma Decimal objects have toString()
  if (typeof value === "object" && "toString" in value) {
    return parseFloat(String(value)) || 0;
  }
  return 0;
}

// ── getDisplayData ─────────────────────────────────────────────────────────

import type { PortfolioItem } from "@/types/api";

/**
 * Pick the right financial summary block based on the portfolio display currency.
 * When portfolio currency is not USD and a portfolio block exists, use it.
 * Otherwise fall back to the USD block.
 */
export function getDisplayData(
  item: PortfolioItem,
  portfolioCurrency: string
) {
  return portfolioCurrency !== "USD" && item.portfolio
    ? item.portfolio
    : item.usd;
}
