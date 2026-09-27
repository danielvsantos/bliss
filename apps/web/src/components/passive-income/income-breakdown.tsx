import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronLeft, ChevronRight, Pencil, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { BreakdownView, PassiveIncomeGroup, PassiveIncomeItem } from '@/types/passive-income';

interface Props {
  items: PassiveIncomeItem[];
  /** #83 — per-symbol / per-cash-currency groups. Absent from older APIs → flat view only. */
  groups?: PassiveIncomeGroup[];
  view?: BreakdownView;
  onViewChange?: (view: BreakdownView) => void;
  currency: string;
  onEditAsset: (item: PassiveIncomeItem) => void;
  onEditStream: (item: PassiveIncomeItem) => void;
  /** A security group held in more than one account (opens the modal in symbol scope). */
  onEditGroup?: (group: PassiveIncomeGroup) => void;
}

export const BREAKDOWN_PAGE_SIZE = 20;

type BreakdownFilter = 'all' | 'assets' | 'streams' | 'attention';
const FILTERS: BreakdownFilter[] = ['all', 'assets', 'streams', 'attention'];
const VIEWS: BreakdownView[] = ['grouped', 'flat'];

const SOURCE_CLASS: Record<PassiveIncomeGroup['source'], string> = {
  AUTO: 'bg-positive/10 text-positive border-positive/20',
  OVERRIDE: 'bg-brand-primary/10 text-brand-primary border-brand-primary/20',
  MANUAL: 'bg-muted text-muted-foreground border-gray-200',
  MISSING: 'bg-warning/10 text-warning border-warning/20',
  MIXED: 'bg-muted text-brand-deep border-gray-200',
};

const STATUS_CLASS: Record<string, string> = {
  MATURED_UNREDEEMED: 'bg-warning/10 text-warning border-warning/20',
  ENDED: 'bg-muted text-muted-foreground border-gray-200',
  STALE_RATE: 'bg-warning/10 text-warning border-warning/20',
};

/** A breakdown line: a holding group (grouped view) or a single item (holding or stream). */
type Row =
  | { type: 'group'; key: string; group: PassiveIncomeGroup }
  | { type: 'item'; key: string; item: PassiveIncomeItem };

const itemKey = (item: PassiveIncomeItem) => `${item.kind}-${item.portfolioItemId ?? item.streamId}`;
const groupKey = (g: PassiveIncomeGroup) => `G-${g.assetClass}-${g.groupKey}`;
const rowTotal = (r: Row) => (r.type === 'group' ? r.group.horizonTotal : r.item.horizonTotal);
const rowLabel = (r: Row) => (r.type === 'group' ? r.group.label : r.item.label);
const rowStatus = (r: Row) => (r.type === 'group' ? r.group.status : r.item.status);

/**
 * Breakdown by holding or stream. Two views (#83):
 *   - grouped (default): one row per symbol and one per cash currency, each
 *     expandable into its per-account rows; streams stay single rows.
 *   - flat: one row per holding (symbol × account), as in #77.
 * A table from `md` up, stacked cards on phones. Search, a kind/attention
 * filter and client-side pagination (20 per page) work on rows of the current
 * view, so large portfolios (100+ holdings) stay scannable.
 */
export function IncomeBreakdown({
  items,
  groups,
  view = 'grouped',
  onViewChange,
  currency,
  onEditAsset,
  onEditStream,
  onEditGroup,
}: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || 'en-US';
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<BreakdownFilter>('all');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const grouped = view === 'grouped' && Array.isArray(groups);

  const rows = useMemo<Row[]>(() => {
    if (!grouped) return items.map((item) => ({ type: 'item', key: itemKey(item), item }));
    const out: Row[] = [
      ...(groups ?? []).map((group): Row => ({ type: 'group', key: groupKey(group), group })),
      ...items.filter((i) => i.kind === 'STREAM').map((item): Row => ({ type: 'item', key: itemKey(item), item })),
    ];
    return out.sort((a, b) => rowTotal(b) - rowTotal(a) || String(rowLabel(a)).localeCompare(String(rowLabel(b))));
  }, [grouped, groups, items]);

  const q = query.trim().toLowerCase();
  const typeLabel = useCallback(
    (type: string) => (type === 'MIXED' ? t('passiveIncome.breakdown.mixed') : t(`passiveIncome.incomeType.${type}`)),
    [t],
  );

  // Groups whose ACCOUNT matched the search open automatically (R6.1).
  const { filtered, autoExpanded } = useMemo(() => {
    const auto = new Set<string>();
    const list = rows.filter((row) => {
      const isStream = row.type === 'item' && row.item.kind === 'STREAM';
      if (filter === 'assets' && isStream) return false;
      if (filter === 'streams' && !isStream) return false;
      if (filter === 'attention' && rowStatus(row) === 'OK') return false;
      if (!q) return true;
      if (row.type === 'item') {
        const { item } = row;
        return [item.label, item.symbol ?? '', item.categoryName ?? '', item.accountName ?? '', typeLabel(item.incomeType)]
          .join(' ').toLowerCase().includes(q);
      }
      const { group } = row;
      const own = [group.label, group.symbol ?? '', group.groupKey, typeLabel(group.incomeType)].join(' ').toLowerCase();
      if (own.includes(q)) return true;
      const accountHit = group.children.some((c) => (c.accountName ?? '').toLowerCase().includes(q));
      if (accountHit && group.accountCount > 1) auto.add(row.key);
      return accountHit;
    });
    return { filtered: list, autoExpanded: auto };
  }, [rows, q, filter, typeLabel]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / BREAKDOWN_PAGE_SIZE));
  useEffect(() => {
    setPage(1);
  }, [query, filter, view]);
  const currentPage = Math.min(page, pageCount);
  const pageRows = filtered.slice((currentPage - 1) * BREAKDOWN_PAGE_SIZE, currentPage * BREAKDOWN_PAGE_SIZE);
  const attentionCount = rows.filter((r) => rowStatus(r) !== 'OK').length;

  const isOpen = (key: string) => expanded.has(key) || autoExpanded.has(key);
  const toggle = (key: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(key) || autoExpanded.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const money = (v: number | null) => (v == null ? '—' : formatCurrency(v, currency, locale));
  const date = (v: string | null) => (v ? formatDate(v, undefined, locale) : '—');
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  const rate = (row: PassiveIncomeItem | PassiveIncomeGroup) => {
    if ('rateRange' in row && row.rateRange) {
      return `${(row.rateRange[0] * 100).toFixed(2)}–${(row.rateRange[1] * 100).toFixed(2)}%`;
    }
    if (row.rateOrYield != null) return pct(row.rateOrYield);
    if (row.amountPerPayment != null) return money(row.amountPerPayment);
    return '—';
  };
  const freq = (row: PassiveIncomeItem | PassiveIncomeGroup) => (row.frequency ? t(`passiveIncome.frequency.${row.frequency}`) : '—');
  const editItem = (item: PassiveIncomeItem) => (item.kind === 'STREAM' ? onEditStream(item) : onEditAsset(item));

  /** Edit action of a group row: multi-account securities → group mode; cash groups are read-only (R4.7). */
  const groupEdit = (g: PassiveIncomeGroup): (() => void) | null => {
    if (g.accountCount === 1) return () => onEditAsset(g.children[0]);
    if (g.kind === 'CASH' || !onEditGroup) return null;
    return () => onEditGroup(g);
  };

  const badges = (row: PassiveIncomeItem | PassiveIncomeGroup) => (
    <span className="inline-flex flex-wrap gap-1">
      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${SOURCE_CLASS[row.source]}`}>
        {t(`passiveIncome.source.${row.source}`)}
      </Badge>
      {row.status !== 'OK' && (
        <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${STATUS_CLASS[row.status]}`}>
          {t(`passiveIncome.status.${row.status}`)}
          {'statusCount' in row && row.accountCount > 1 && row.statusCount > 0 ? ` · ${row.statusCount}` : ''}
        </Badge>
      )}
    </span>
  );

  const groupSubtitle = (g: PassiveIncomeGroup) => {
    const parts: string[] = [
      g.accountCount > 1
        ? t('passiveIncome.breakdown.accounts', { count: g.accountCount })
        : g.children[0]?.accountName ?? '',
    ];
    if (g.kind === 'CASH') {
      parts.push(t('passiveIncome.breakdown.cashSummary', {
        balance: money(g.currentValue),
        monthly: money(Math.round((g.next12mTotal / 12) * 100) / 100),
      }));
    } else if (g.accountCount > 1 && g.quantity > 0) {
      parts.push(t('passiveIncome.breakdown.quantity', { value: g.quantity.toLocaleString(locale, { maximumFractionDigits: 4 }) }));
    }
    return parts.filter(Boolean).join(' · ');
  };

  const editButton = (onClick: (() => void) | null, label?: string) =>
    onClick ? (
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        aria-label={label ?? t('common.edit')}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
    ) : null;

  // ── Desktop rows ──────────────────────────────────────────────────────────
  const itemCells = (item: PassiveIncomeItem, title: ReactNode, nested = false) => (
    <>
      <td className={`py-2.5 pr-3 ${nested ? 'pl-12' : 'pl-3'}`}>
        {title}
        <div className="mt-0.5">{badges(item)}</div>
      </td>
      <td className="px-3 py-2.5 text-muted-foreground">{t(`passiveIncome.incomeType.${item.incomeType}`)}</td>
      <td className="px-3 py-2.5 tabular-nums">{rate(item)}</td>
      <td className="px-3 py-2.5 text-muted-foreground">{freq(item)}</td>
      <td className="px-3 py-2.5 tabular-nums">{date(item.nextPaymentDate)}</td>
      <td className="px-3 py-2.5 tabular-nums">{date(item.endDate)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums font-medium">{money(item.horizonTotal)}</td>
      <td className="px-3 py-2.5 text-right">{editButton(() => editItem(item))}</td>
    </>
  );

  const desktopRow = (row: Row) => {
    if (row.type === 'item') {
      return (
        <tr key={row.key} className="border-b border-gray-50 hover:bg-accent/40">
          {itemCells(row.item, <div className="font-medium text-brand-deep">{row.item.label}</div>)}
        </tr>
      );
    }
    const g = row.group;
    const multi = g.accountCount > 1;
    const open = multi && isOpen(row.key);
    return (
      <Fragment key={row.key}>
        <tr
          className={`border-b border-gray-50 hover:bg-accent/40 ${multi ? 'cursor-pointer' : ''}`}
          onClick={multi ? () => toggle(row.key) : undefined}
          data-testid={`group-row-${g.groupKey}`}
          aria-expanded={multi ? open : undefined}
        >
          <td className="px-3 py-2.5">
            <div className="flex items-start gap-1.5">
              {multi ? (
                <button
                  type="button"
                  className="mt-0.5 text-muted-foreground hover:text-brand-deep"
                  aria-label={open ? t('passiveIncome.breakdown.hideAccounts') : t('passiveIncome.breakdown.showAccounts', { count: g.accountCount })}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(row.key);
                  }}
                >
                  <ChevronDown className={`h-4 w-4 transition-transform ${open ? '' : '-rotate-90'}`} />
                </button>
              ) : (
                <span className="w-4 shrink-0" />
              )}
              <div className="min-w-0">
                <div className="font-medium text-brand-deep">{g.label}</div>
                <div className="text-xs text-muted-foreground">{groupSubtitle(g)}</div>
                <div className="mt-0.5">{badges(g)}</div>
              </div>
            </div>
          </td>
          <td className="px-3 py-2.5 text-muted-foreground">{typeLabel(g.incomeType)}</td>
          <td className="px-3 py-2.5 tabular-nums">{rate(g)}</td>
          <td className="px-3 py-2.5 text-muted-foreground">{freq(g)}</td>
          <td className="px-3 py-2.5 tabular-nums">{date(g.nextPaymentDate)}</td>
          <td className="px-3 py-2.5 tabular-nums">{date(g.endDate)}</td>
          <td className="px-3 py-2.5 text-right tabular-nums font-medium">{money(g.horizonTotal)}</td>
          <td className="px-3 py-2.5 text-right">
            {editButton(groupEdit(g), multi ? t('passiveIncome.breakdown.editGroup', { name: g.label }) : undefined)}
          </td>
        </tr>
        {open && g.children.map((child) => (
          <tr key={`${row.key}-${child.portfolioItemId}`} className="border-b border-gray-50 bg-accent/20 hover:bg-accent/40" data-testid={`child-row-${child.portfolioItemId}`}>
            {itemCells(child, <div className="text-brand-deep">{child.accountName ?? child.label}</div>, true)}
          </tr>
        ))}
      </Fragment>
    );
  };

  // ── Phone cards ───────────────────────────────────────────────────────────
  const itemCard = (item: PassiveIncomeItem, title: string, nested = false) => (
    <button
      type="button"
      onClick={() => editItem(item)}
      className={`w-full text-left rounded-md border border-gray-200 p-3 hover:bg-accent/40 ${nested ? 'bg-accent/20' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-brand-deep truncate">{title}</p>
          <p className="text-xs text-muted-foreground">
            {t(`passiveIncome.incomeType.${item.incomeType}`)} · {freq(item)} · {rate(item)}
          </p>
        </div>
        <p className="font-semibold tabular-nums shrink-0">{money(item.horizonTotal)}</p>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        {badges(item)}
        <span>
          {t('passiveIncome.breakdown.nextPayment')}: {date(item.nextPaymentDate)}
          {item.endDate ? ` · ${t('passiveIncome.breakdown.endDate')}: ${date(item.endDate)}` : ''}
        </span>
      </div>
    </button>
  );

  const card = (row: Row) => {
    if (row.type === 'item') return <li key={row.key}>{itemCard(row.item, row.item.label)}</li>;
    const g = row.group;
    const multi = g.accountCount > 1;
    const open = multi && isOpen(row.key);
    const edit = groupEdit(g);
    return (
      <li key={row.key} className="rounded-md border border-gray-200 p-3" data-testid={`group-card-${g.groupKey}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-medium text-brand-deep truncate">{g.label}</p>
            <p className="text-xs text-muted-foreground">{groupSubtitle(g)}</p>
            <p className="text-xs text-muted-foreground">
              {typeLabel(g.incomeType)} · {freq(g)} · {rate(g)}
            </p>
          </div>
          <div className="flex items-start gap-1 shrink-0">
            <p className="font-semibold tabular-nums">{money(g.horizonTotal)}</p>
            {editButton(edit, multi ? t('passiveIncome.breakdown.editGroup', { name: g.label }) : undefined)}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          {badges(g)}
          <span>{t('passiveIncome.breakdown.nextPayment')}: {date(g.nextPaymentDate)}</span>
        </div>
        {multi && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 h-7 px-2 text-xs"
            aria-expanded={open}
            onClick={() => toggle(row.key)}
          >
            <ChevronDown className={`h-3.5 w-3.5 mr-1 transition-transform ${open ? '' : '-rotate-90'}`} />
            {open ? t('passiveIncome.breakdown.hideAccounts') : t('passiveIncome.breakdown.showAccounts', { count: g.accountCount })}
          </Button>
        )}
        {open && (
          <ul className="mt-2 space-y-2">
            {g.children.map((child) => (
              <li key={`${row.key}-${child.portfolioItemId}`}>{itemCard(child, child.accountName ?? child.label, true)}</li>
            ))}
          </ul>
        )}
      </li>
    );
  };

  if (items.length === 0 && (groups?.length ?? 0) === 0) {
    return <p className="text-sm text-muted-foreground py-6 text-center">{t('passiveIncome.breakdown.empty')}</p>;
  }

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 mb-3">
        <div className="relative sm:max-w-xs flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('passiveIncome.breakdown.search')}
            aria-label={t('passiveIncome.breakdown.search')}
            className="pl-8 h-9"
          />
        </div>
        <div className="inline-flex flex-wrap gap-1" role="group" aria-label={t('passiveIncome.breakdown.filter')}>
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                filter === f
                  ? 'bg-primary text-white border-primary'
                  : 'border-gray-200 text-muted-foreground hover:text-brand-deep'
              }`}
            >
              {t(`passiveIncome.breakdown.filters.${f}`)}
              {f === 'attention' && attentionCount > 0 ? ` (${attentionCount})` : ''}
            </button>
          ))}
        </div>
        {Array.isArray(groups) && onViewChange && (
          <div
            className="inline-flex rounded-md border border-gray-200 p-0.5 sm:ml-auto self-start"
            role="group"
            aria-label={t('passiveIncome.breakdown.view.label')}
            data-testid="breakdown-view-toggle"
          >
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => onViewChange(v)}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${
                  view === v ? 'bg-primary text-white font-medium' : 'text-muted-foreground hover:text-brand-deep'
                }`}
              >
                {t(`passiveIncome.breakdown.view.${v}`)}
              </button>
            ))}
          </div>
        )}
      </div>

      {filtered.length === 0 && (
        <p className="text-sm text-muted-foreground py-6 text-center">{t('passiveIncome.breakdown.noMatches')}</p>
      )}

      {/* Desktop / tablet table */}
      <div className={filtered.length === 0 ? 'hidden' : 'hidden md:block overflow-x-auto'}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2 font-medium">{t('passiveIncome.breakdown.holding')}</th>
              <th className="px-3 py-2 font-medium">{t('passiveIncome.breakdown.type')}</th>
              <th className="px-3 py-2 font-medium">{t('passiveIncome.breakdown.rateOrAmount')}</th>
              <th className="px-3 py-2 font-medium">{t('passiveIncome.breakdown.frequency')}</th>
              <th className="px-3 py-2 font-medium">{t('passiveIncome.breakdown.nextPayment')}</th>
              <th className="px-3 py-2 font-medium">{t('passiveIncome.breakdown.endDate')}</th>
              <th className="px-3 py-2 font-medium text-right">{t('passiveIncome.breakdown.horizonTotal')}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>{pageRows.map(desktopRow)}</tbody>
        </table>
      </div>

      {/* Phone cards */}
      <ul className={filtered.length === 0 ? 'hidden' : 'md:hidden space-y-2'} data-testid="breakdown-cards">
        {pageRows.map(card)}
      </ul>
      {pageCount > 1 && (
        <div className="flex items-center justify-between gap-2 pt-3 text-xs text-muted-foreground" data-testid="breakdown-pager">
          <span>
            {t('passiveIncome.breakdown.showing', {
              from: (currentPage - 1) * BREAKDOWN_PAGE_SIZE + 1,
              to: Math.min(currentPage * BREAKDOWN_PAGE_SIZE, filtered.length),
              total: filtered.length,
            })}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0"
              aria-label={t('passiveIncome.breakdown.prev')}
              disabled={currentPage <= 1}
              onClick={() => setPage(currentPage - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="tabular-nums px-1">{currentPage} / {pageCount}</span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0"
              aria-label={t('passiveIncome.breakdown.next')}
              disabled={currentPage >= pageCount}
              onClick={() => setPage(currentPage + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
