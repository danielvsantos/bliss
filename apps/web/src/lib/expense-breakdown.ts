// Expense breakdown (#140): the one definition of "spend" shared by the
// Expenses report and the Dashboard Expense Split card.
//
// Expense = Σ debit − Σ credit per category group, summed across the selected
// expense types (group-level netting). Credits booked to an expense category
// (refunds, reimbursements, a flatmate's share, insurance payouts) reduce the
// spend. With the "Include credits" toggle off, debits only (never negative).

export const EXPENSE_TYPES = ['Essentials', 'Lifestyle', 'Growth'] as const;

/** 'net' = debit − credit (default); 'debit' = debits only. */
export type ExpenseBasis = 'net' | 'debit';

export type ExpenseCell = { debit?: number | null; credit?: number | null; balance?: number | null };

/** `/api/analytics?view=month` payload: month → type → group → cell. */
export type ExpenseAnalyticsData = Record<string, Record<string, Record<string, ExpenseCell>>>;

/** Below this, a netted value is float residue: neither a slice nor a net credit. */
const EPSILON = 0.005;

const isZero = (v: number) => Math.abs(v) < EPSILON;

/** debit − credit, or debit only. Missing fields count as 0. */
export function expenseValue(cell: ExpenseCell | undefined, basis: ExpenseBasis): number {
  if (!cell) return 0;
  const debit = Number(cell.debit) || 0;
  if (basis === 'debit') return debit;
  return debit - (Number(cell.credit) || 0);
}

function asData(data: unknown): ExpenseAnalyticsData {
  return data && typeof data === 'object' ? (data as ExpenseAnalyticsData) : {};
}

function addMonth(
  target: Record<string, number>,
  monthData: Record<string, Record<string, ExpenseCell>> | undefined,
  types: readonly string[],
  basis: ExpenseBasis,
) {
  if (!monthData) return;
  for (const type of types) {
    const typeData = monthData[type];
    if (!typeData) continue;
    for (const group in typeData) {
      target[group] = (target[group] ?? 0) + expenseValue(typeData[group], basis);
    }
  }
}

/** Group → signed value over the whole period, summed across `types`. */
export function aggregateExpenseGroups(
  data: unknown,
  types: readonly string[],
  basis: ExpenseBasis,
): Record<string, number> {
  const months = asData(data);
  const groups: Record<string, number> = {};
  for (const month in months) addMonth(groups, months[month], types, basis);
  return groups;
}

/** Month → group → signed value (for the trend chart), months ascending. */
export function aggregateExpenseGroupsByMonth(
  data: unknown,
  types: readonly string[],
  basis: ExpenseBasis,
): Array<{ month: string; groups: Record<string, number> }> {
  const months = asData(data);
  return Object.keys(months)
    .sort()
    .map((month) => {
      const groups: Record<string, number> = {};
      addMonth(groups, months[month], types, basis);
      return { month, groups };
    });
}

export interface ExpenseSlice {
  name: string;
  value: number;
  /** Share of `shareTotal`, 1 decimal. */
  percentage: number;
  isOther: boolean;
}

export interface ExpenseBreakdown {
  /** Signed sum of every group: the KPI total (matches Financial Summary). */
  total: number;
  /** Sum of the positive groups: the only pie / percentage denominator. */
  shareTotal: number;
  /** Positive groups, largest first; top `maxSlices` plus one "Other" built only from positive groups. */
  slices: ExpenseSlice[];
  /** Groups where credits exceed debits, most negative first. */
  netCredits: Array<{ name: string; value: number }>;
  /** Largest positive group, or null when there is none. */
  highest: { name: string; value: number } | null;
  /** Every group with non-zero activity, largest first (feeds the trend picker). */
  allGroups: string[];
}

const pct = (value: number, of: number) => (of > 0 ? Math.round((value / of) * 1000) / 10 : 0);

export function buildExpenseBreakdown(
  groups: Record<string, number>,
  opts: { maxSlices: number; otherLabel: string },
): ExpenseBreakdown {
  const entries = Object.entries(groups)
    .filter(([, value]) => !isZero(value))
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  const positive = entries.filter((e) => e.value > 0);
  const total = entries.reduce((sum, e) => sum + e.value, 0);
  const shareTotal = positive.reduce((sum, e) => sum + e.value, 0);

  const slices: ExpenseSlice[] = positive.slice(0, opts.maxSlices).map((e) => ({
    ...e,
    percentage: pct(e.value, shareTotal),
    isOther: false,
  }));
  const otherValue = positive.slice(opts.maxSlices).reduce((sum, e) => sum + e.value, 0);
  if (otherValue > 0) {
    slices.push({ name: opts.otherLabel, value: otherValue, percentage: pct(otherValue, shareTotal), isOther: true });
  }

  const netCredits = entries.filter((e) => e.value < 0).sort((a, b) => a.value - b.value);

  return {
    total: isZero(total) ? 0 : total,
    shareTotal,
    slices,
    netCredits,
    highest: positive[0] ?? null,
    allGroups: entries.map((e) => e.name),
  };
}

// ─── "Include credits" toggle ──────────────────────────────────────────────

export const EXPENSE_INCLUDE_CREDITS_KEY = 'bliss.expenses.includeCredits';

/** The remembered toggle (per browser). On by default; storage may be unavailable. */
export function readIncludeCredits(): boolean {
  try {
    return window.localStorage.getItem(EXPENSE_INCLUDE_CREDITS_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function writeIncludeCredits(value: boolean): void {
  try {
    window.localStorage.setItem(EXPENSE_INCLUDE_CREDITS_KEY, String(value));
  } catch {
    // Private mode / blocked storage: the choice just isn't remembered.
  }
}
