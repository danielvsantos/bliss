import React, { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePlaidTransactions } from "@/hooks/use-plaid-review";
import { usePendingImports } from "@/hooks/use-imports";
import { usePageVisible } from "@/hooks/use-page-visible";
import { FileUp, Lightbulb, BarChart3, Tags, TrendingUp, LineChart, Briefcase, Hash, PieChart } from "lucide-react";

/* ── Nav Icons ──────────────────────────────────────── */
function DashboardIcon({ active }: { active?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2" y="2" width="6.5" height="6.5" rx="1.75"
        stroke="currentColor" strokeWidth="1.5" fill={active ? "currentColor" : "none"} fillOpacity={active ? 0.18 : 0} />
      <rect x="9.5" y="2" width="6.5" height="6.5" rx="1.75"
        stroke="currentColor" strokeWidth="1.5" />
      <rect x="2" y="9.5" width="6.5" height="6.5" rx="1.75"
        stroke="currentColor" strokeWidth="1.5" />
      <rect x="9.5" y="9.5" width="6.5" height="6.5" rx="1.75"
        stroke="currentColor" strokeWidth="1.5" fill={active ? "currentColor" : "none"} fillOpacity={active ? 0.18 : 0} />
    </svg>
  );
}

function AccountsIcon({ active }: { active?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2" y="5" width="14" height="10" rx="2"
        stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 8.5h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M5.5 12h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M9.5 12h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M5 5V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function TransactionsIcon({ active }: { active?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M3 5.5h12M11.5 2.5l3.5 3-3.5 3"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15 12.5H3M6.5 9.5l-3.5 3 3.5 3"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AIReviewIcon({ active }: { active?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M9 2v2M9 14v2M2 9h2M14 9h2M4.22 4.22l1.42 1.42M12.36 12.36l1.42 1.42M4.22 13.78l1.42-1.42M12.36 5.64l1.42-1.42"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="9" cy="9" r="2.75" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function SettingsIcon({ active }: { active?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M9 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"
        stroke="currentColor" strokeWidth="1.5"
      />
      <path
        d="M14.45 11a5.5 5.5 0 0 0 .11-.9c0-.32-.04-.63-.11-.93l1.96-1.53a.45.45 0 0 0 .1-.58l-1.86-3.22a.45.45 0 0 0-.55-.2l-2.31.93a5.45 5.45 0 0 0-1.6-.93L9.75 2.1A.45.45 0 0 0 9.31 1.7H5.59a.45.45 0 0 0-.44.38l-.34 2.44a5.45 5.45 0 0 0-1.6.93l-2.31-.93a.45.45 0 0 0-.55.2L.49 7.94a.44.44 0 0 0 .1.58l1.96 1.53a5.54 5.54 0 0 0 0 1.86l-1.96 1.53a.45.45 0 0 0-.1.58l1.86 3.22c.12.21.37.29.55.2l2.31-.93c.5.36 1.04.65 1.6.93l.34 2.44c.06.22.24.38.44.38h3.72c.2 0 .38-.16.44-.38l.34-2.44a5.45 5.45 0 0 0 1.6-.93l2.31.93c.18.09.43.01.55-.2l1.86-3.22a.44.44 0 0 0-.1-.58L14.45 11z"
        stroke="currentColor" strokeWidth="1.4"
      />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M11 4.5L6.5 9l4.5 4.5"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const createIcon = (Icon: React.ElementType) => ({ active }: { active?: boolean }) => (
  <Icon size={18} strokeWidth={1.5} color="currentColor" />
);

const CategoriesIcon = createIcon(Tags);
const AssetsLiabilitiesIcon = createIcon(TrendingUp);
const PnLIcon = createIcon(LineChart);
const ExpensesIcon = createIcon(BarChart3);
const PortfolioIcon = createIcon(Briefcase);
const ImportAgentIcon = createIcon(FileUp);
const InsightAgentIcon = createIcon(Lightbulb);
const TagAnalyticsIcon = createIcon(Hash);
const EquityAnalysisIcon = createIcon(PieChart);

/* ── Tooltip (for collapsed state) ─────────────────── */
function NavTooltip({ label, visible }: { label: string; visible: boolean }) {
  return (
    <div
      style={{
        position: "absolute",
        left: "calc(100% + 10px)",
        top: "50%",
        transform: "translateY(-50%)",
        background: "hsl(var(--brand-deep))",
        color: "#FFFFFF",
        fontFamily: "'Urbanist', sans-serif",
        fontSize: "0.8125rem",
        fontWeight: 500,
        padding: "5px 10px",
        borderRadius: "8px",
        whiteSpace: "nowrap",
        pointerEvents: "none",
        opacity: visible ? 1 : 0,
        transition: "opacity 0.15s ease",
        zIndex: 100,
        boxShadow: "0 2px 8px rgba(58,53,66,0.2)",
      }}
    >
      {label}
      <div style={{
        position: "absolute",
        right: "100%",
        top: "50%",
        transform: "translateY(-50%)",
        width: 0, height: 0,
        borderTop: "4px solid transparent",
        borderBottom: "4px solid transparent",
        borderRight: "5px solid hsl(var(--brand-deep))",
      }} />
    </div>
  );
}

/* ── Nav Item Badge ─────────────────────────────────── */
function NavBadge({ count }: { count: number }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 18,
        height: 18,
        borderRadius: 99,
        background: "hsl(var(--negative))",
        color: "#fff",
        fontFamily: "'Urbanist', sans-serif",
        fontSize: "0.625rem",
        fontWeight: 700,
        padding: "0 4px",
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

/* ── Sidebar Component ──────────────────────────────── */
export interface SidebarProps {
  collapsed?: boolean;
  defaultCollapsed?: boolean;
  onItemClick?: (id: string) => void;
  onCollapseToggle?: (next: boolean) => void;
  onClose?: () => void;
}

export function Sidebar({
  collapsed: controlledCollapsed,
  defaultCollapsed = false,
  onItemClick,
  onCollapseToggle,
  onClose,
}: SidebarProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);
  const isVisible = usePageVisible();

  // Poll for review counts (paused when tab is hidden)
  const { data: plaidData } = usePlaidTransactions(
    { limit: 1 },
    { staleTime: 0, refetchInterval: isVisible ? 60_000 : false }
  );
  const { data: pendingData } = usePendingImports();
  const plaidPendingCount = plaidData?.summary?.classified ?? 0;
  const importPendingCount = (pendingData?.imports ?? []).reduce(
    (sum: number, imp: any) => sum + (imp.pendingRowCount ?? 0),
    0
  );
  const totalReviewCount = plaidPendingCount + importPendingCount;

  // Active state: exact match for root-level pages; prefix match only for leaf paths
  // This prevents /agents from being highlighted when on /agents/review etc.
  const isActive = (href: string, exact = false) => {
    if (href === '/') return location.pathname === '/';
    if (exact) return location.pathname === href;
    return location.pathname === href || location.pathname.startsWith(href + '/');
  };

  const NAV_ITEMS: Array<
    | { type: 'link'; id: string; href: string; label: string; icon: any; badge: number; exact: boolean }
    | { type: 'section'; label: string }
  > = [
    // ── Main
    { type: 'link', id: "dashboard", href: "/", label: t('nav.dashboard'), icon: DashboardIcon, badge: 0, exact: true },
    { type: 'link', id: "accounts", href: "/accounts", label: t('nav.accounts'), icon: AccountsIcon, badge: 0, exact: false },
    { type: 'link', id: "transactions", href: "/transactions", label: t('nav.transactions'), icon: TransactionsIcon, badge: 0, exact: false },
    { type: 'link', id: "categories", href: "/categories", label: t('nav.categories'), icon: CategoriesIcon, badge: 0, exact: false },
    // ── Reports
    { type: 'section', label: 'REPORTS' },
    { type: 'link', id: "pnl", href: "/reports/pnl", label: t('nav.pnlAnalysis'), icon: PnLIcon, badge: 0, exact: false },
    { type: 'link', id: "expenses", href: "/reports/expenses", label: t('nav.expenses'), icon: ExpensesIcon, badge: 0, exact: false },
    { type: 'link', id: "portfolio", href: "/reports/portfolio", label: t('nav.portfolioHoldings'), icon: PortfolioIcon, badge: 0, exact: false },
    { type: 'link', id: "tag-analytics", href: "/reports/tags", label: 'Tag Analytics', icon: TagAnalyticsIcon, badge: 0, exact: false },
    { type: 'link', id: "equity-analysis", href: "/reports/equity-analysis", label: 'Equity Analysis', icon: EquityAnalysisIcon, badge: 0, exact: false },
    // ── Tools
    { type: 'section', label: 'TOOLS' },
    { type: 'link', id: "assets", href: "/manual-updates", label: t('nav.assetPriceUpdates'), icon: AssetsLiabilitiesIcon, badge: 0, exact: false },
    { type: 'link', id: "import-agent", href: "/agents/import", label: t('nav.importAgent'), icon: ImportAgentIcon, badge: 0, exact: false },
    { type: 'link', id: "ai-review", href: "/agents/review", label: t('nav.transactionReview'), icon: AIReviewIcon, badge: totalReviewCount, exact: false },
    { type: 'link', id: "insight-agent", href: "/agents/insight", label: t('nav.insightAgent'), icon: InsightAgentIcon, badge: 0, exact: false },
    // ── Settings
    { type: 'link', id: "settings", href: "/settings", label: t('nav.settings'), icon: SettingsIcon, badge: 0, exact: false },
  ];

  const [internalCollapsed, setInternalCollapsed] = useState(defaultCollapsed);
  const isCollapsed = controlledCollapsed !== undefined ? controlledCollapsed : internalCollapsed;

  const handleToggle = () => {
    const next = !isCollapsed;
    if (controlledCollapsed === undefined) {
      setInternalCollapsed(next);
    }
    onCollapseToggle?.(next);
  };

  const EXPANDED_W = 240;
  const COLLAPSED_W = 64;
  const width = isCollapsed ? COLLAPSED_W : EXPANDED_W;

  return (
    <aside
      style={{
        width,
        minWidth: width,
        height: "100%",
        background: "hsl(var(--background))",
        borderRight: "1px solid hsl(var(--border-color))",
        display: "flex",
        flexDirection: "column",
        transition: "width 0.22s cubic-bezier(0.4, 0, 0.2, 1), min-width 0.22s cubic-bezier(0.4, 0, 0.2, 1)",
        overflow: "hidden",
        flexShrink: 0,
        position: "relative",
        zIndex: 10,
      }}
      aria-label="Main navigation"
    >
      {/* ── Logo area ─────────────────────────────── */}
      <div
        style={{
          height: 60,
          display: "flex",
          alignItems: "center",
          justifyContent: isCollapsed ? "center" : "space-between",
          padding: isCollapsed ? "0" : "0 20px",
          borderBottom: "1px solid hsl(var(--border-color))",
          flexShrink: 0,
          overflow: "hidden",
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {isCollapsed ? (
            <div
              style={{
                width: 32, height: 32,
                borderRadius: "10px",
                background: "hsl(var(--brand-deep))",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  fontFamily: "'Urbanist', sans-serif",
                  fontSize: "0.9375rem",
                  fontWeight: 600,
                  color: "#FFFFFF",
                  letterSpacing: "-0.03em",
                  lineHeight: 1,
                }}
              >
                b
              </span>
            </div>
          ) : (
            <div style={{ padding: "16px 0" }}>
              <span
                style={{
                  fontFamily: "'Urbanist', sans-serif",
                  fontSize: "1.375rem",
                  fontWeight: 600,
                  letterSpacing: "-0.04em",
                  color: "hsl(var(--brand-primary))",
                  lineHeight: 1,
                  userSelect: "none",
                }}
              >
                bliss
              </span>
            </div>
          )}
        </div>
        {!isCollapsed && onClose && (
          <button onClick={onClose} className="lg:hidden text-muted-fg bg-transparent border-none cursor-pointer p-1">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        )}
      </div>

      {/* ── Navigation Items ─────────────────────── */}
      <nav
        style={{
          flex: 1,
          padding: "10px 8px",
          display: "flex",
          flexDirection: "column",
          gap: 2,
          overflowY: "auto",
          overflowX: "hidden",
        }}
      >
        {NAV_ITEMS.map((item, idx) => {
          if (item.type === 'section') {
            if (isCollapsed) return null;
            return (
              <div key={`section-${item.label}`} style={{ padding: '12px 12px 4px', marginTop: idx > 0 ? 4 : 0 }}>
                <span style={{
                  fontFamily: "'Urbanist', sans-serif",
                  fontSize: '0.625rem',
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  color: 'hsl(var(--muted-fg))',
                  textTransform: 'uppercase',
                }}>{item.label}</span>
              </div>
            );
          }

          const itemIsActive = isActive(item.href, item.exact);
          const isHovered = hoveredItem === item.id;
          const IconComp = item.icon;

          return (
            <div
              key={item.id}
              style={{ position: "relative" }}
              onMouseEnter={() => setHoveredItem(item.id)}
              onMouseLeave={() => setHoveredItem(null)}
            >
              <Link
                to={item.href}
                onClick={() => {
                  onItemClick?.(item.id);
                  if (onClose) onClose();
                }}
                aria-label={item.label}
                aria-current={itemIsActive ? "page" : undefined}
                style={{
                  display: "flex",
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: isCollapsed ? "center" : "flex-start",
                  gap: 12,
                  paddingTop: 8,
                  paddingBottom: 8,
                  paddingLeft: 12,
                  paddingRight: 12,
                  width: "100%",
                  borderRadius: "0.75rem",
                  border: "none",
                  cursor: "pointer",
                  background: itemIsActive
                    ? "hsl(var(--brand-deep))"
                    : isHovered
                      ? "hsl(var(--input-background))"
                      : "transparent",
                  color: itemIsActive ? "#FFFFFF" : isHovered ? "hsl(var(--brand-deep))" : "hsl(var(--brand-primary))",
                  transition: "background 0.14s ease, color 0.14s ease",
                  outline: "none",
                  position: "relative",
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  textDecoration: "none",
                  boxShadow: itemIsActive ? "0 2px 8px rgba(58,53,66,0.18)" : "none",
                }}
              >
                {/* Icon */}
                <span style={{ display: "flex", alignItems: "center", flexShrink: 0, color: "inherit" }}>
                  <IconComp active={itemIsActive} />
                </span>

                {/* Label */}
                {!isCollapsed && (
                  <span
                    style={{
                      fontFamily: "'Urbanist', sans-serif",
                      fontSize: "1rem",
                      fontWeight: 500,
                      letterSpacing: "0.005em",
                      lineHeight: 1.5,
                      color: "inherit",
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {item.label}
                  </span>
                )}

                {/* Badge */}
                {!isCollapsed && item.badge > 0 && (
                  <NavBadge count={item.badge} />
                )}

                {/* Badge dot (collapsed) */}
                {isCollapsed && item.badge > 0 && (
                  <span
                    style={{
                      position: "absolute",
                      top: 6,
                      right: 6,
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: "hsl(var(--negative))",
                      border: "1.5px solid hsl(var(--background))",
                    }}
                  />
                )}
              </Link>

              {/* Tooltip */}
              {isCollapsed && (
                <NavTooltip label={item.label} visible={isHovered} />
              )}
            </div>
          );
        })}
      </nav>

      {/* ── Bottom section ────────────────────────── */}
      <div className="hidden md:block" style={{ padding: "8px", borderTop: "1px solid hsl(var(--border-color))", flexShrink: 0 }}>
        <button
          onClick={handleToggle}
          title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: isCollapsed ? "center" : "flex-start",
            gap: 12,
            paddingTop: 8,
            paddingBottom: 8,
            paddingLeft: 12,
            paddingRight: 12,
            width: "100%",
            borderRadius: "0.75rem",
            border: "none",
            background: "transparent",
            color: "hsl(var(--muted-fg))",
            cursor: "pointer",
            transition: "background 0.14s ease, color 0.14s ease",
            outline: "none",
            fontFamily: "'Urbanist', sans-serif",
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.background = "hsl(var(--input-background))";
            (e.currentTarget as HTMLButtonElement).style.color = "hsl(var(--brand-deep))";
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.background = "transparent";
            (e.currentTarget as HTMLButtonElement).style.color = "hsl(var(--muted-fg))";
          }}
        >
          <span
            style={{
              display: "flex",
              alignItems: "center",
              flexShrink: 0,
              transition: "transform 0.22s ease",
              transform: isCollapsed ? "rotate(180deg)" : "none",
            }}
          >
            <CollapseIcon />
          </span>
          {!isCollapsed && (
            <span
              style={{
                fontSize: "0.875rem",
                fontWeight: 500,
                letterSpacing: "0.005em",
                lineHeight: 1.5,
                color: "inherit",
              }}
            >
              Collapse
            </span>
          )}
        </button>
      </div>
    </aside>
  );
}
