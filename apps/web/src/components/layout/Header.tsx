import React from "react";
import { Menu, Settings, LogOut, UserCog } from "lucide-react";
import { NotificationCenter } from "@/components/notification-center";
import { useTranslation } from 'react-i18next';
import { LanguageSwitcher } from "@/components/language-switcher";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";

/* ── Header Props ── */
interface HeaderProps {
  sidebarOpen: boolean;
  onSidebarToggle: () => void;
  isMobile?: boolean;
}

export function Header({ sidebarOpen, onSidebarToggle, isMobile = false }: HeaderProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { signOut, user } = useAuth();

  const handleLogout = async () => {
    try {
      await signOut();
      navigate('/auth');
    } catch (error) {
      console.error('Logout failed:', error);
      navigate('/auth');
    }
  };

  const getCurrentPageName = () => {
    const path = location.pathname;
    const pathMap: Record<string, string> = {
      "/": "nav.dashboard",
      "/transactions": "nav.transactions",
      "/accounts": "nav.accounts",
      "/categories": "nav.categories",
      "/manual-updates": "nav.assetPriceUpdates",
      "/reports/pnl": "nav.pnlAnalysis",
      "/reports/expenses": "nav.expenses",
      "/reports/portfolio": "nav.portfolioHoldings",
      "/reports/tags": "nav.tagAnalytics",
      "/reports/equity-analysis": "nav.equityAnalysis",
      "/settings": "nav.settings",
      "/settings/users": "nav.users",
      "/agents/import": "nav.importAgent",
      "/agents/review": "nav.transactionReview",
      "/agents/insight": "nav.insightAgent",
    };

    if (path.startsWith("/reports/")) {
      return t(pathMap[path] || "nav.reports");
    } else if (path.startsWith("/settings/")) {
      return t(pathMap[path] || "nav.settings");
    } else if (path.startsWith("/agents/")) {
      return t(pathMap[path] || "nav.agents");
    }

    return t(pathMap[path] || "common.page");
  };

  const getUserInitials = () => {
    const name = user?.name || user?.email || '';
    if (!name) return 'U';
    const parts = name.split(/[\s@]/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.charAt(0).toUpperCase();
  };

  // Decide if mobile layout for internal components
  const isMobileLayout = isMobile || (typeof window !== 'undefined' && window.innerWidth < 768);

  return (
    <header
      style={{
        height: 60, flexShrink: 0,
        display: "flex", alignItems: "center",
        justifyContent: "space-between",
        padding: isMobileLayout ? "0 12px" : "0 28px",
        background: "rgba(250,250,250,0.96)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        borderBottom: "1px solid hsl(var(--border-color))",
        gap: isMobileLayout ? 8 : 16,
        overflow: "visible",
      }}
      className="dark:bg-[rgba(26,22,37,0.96)] z-10"
    >
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        flexShrink: 1, minWidth: 0, overflow: "hidden",
      }}>
        {/* Mobile Sidebar Hamburger Toggle */}
        <button
          type="button"
          className="md:hidden flex items-center justify-center bg-transparent border-none text-muted-fg cursor-pointer p-1 -ml-2 mr-1"
          onClick={onSidebarToggle}
        >
          <Menu className="h-6 w-6" />
          <span className="sr-only">{t('ui.sidebar')}</span>
        </button>

        {!isMobileLayout && (
          <>
            <span style={{
              fontFamily: "'Urbanist', sans-serif", fontSize: "0.9375rem",
              fontWeight: 500, color: "hsl(var(--muted-fg))", whiteSpace: "nowrap",
            }}>bliss</span>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0 }}>
              <path d="M4.5 3l3 3-3 3" stroke="currentColor" className="text-muted-foreground" strokeWidth="1.5"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </>
        )}
        <span style={{
          fontFamily: "'Urbanist', sans-serif", fontSize: "0.9375rem",
          fontWeight: 500, color: "hsl(var(--brand-deep))",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }} className="dark:text-white">
          {getCurrentPageName()}
        </span>
      </div>

      {/* ── Right cluster ── */}
      <div style={{
        display: "flex", alignItems: "center",
        gap: isMobileLayout ? 6 : 10,
        flexShrink: 0,
      }}>
        {!isMobileLayout && <LanguageSwitcher />}

        <NotificationCenter />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button style={{
              width: 34, height: 34, borderRadius: "0.625rem",
              border: "none", background: "hsl(var(--brand-primary))",
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", color: "#FFF", flexShrink: 0,
              fontFamily: "'Urbanist', sans-serif", fontSize: "0.75rem", fontWeight: 600,
            }}>
              {getUserInitials()}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" align="end" forceMount>
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col space-y-1">
                <p className="text-sm font-medium leading-none">{user?.name || 'User'}</p>
                <p className="text-xs leading-none text-muted-foreground">
                  {user?.email || ''}
                </p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <Link to="/settings" className="flex w-full items-center">
                  <Settings className="mr-2 h-4 w-4" />
                  <span>{t('nav.settings')}</span>
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/settings/users" className="flex w-full items-center">
                  <UserCog className="mr-2 h-4 w-4" />
                  <span>{t('nav.users')}</span>
                </Link>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={handleLogout}
              className="cursor-pointer text-destructive focus:text-destructive"
            >
              <LogOut className="mr-2 h-4 w-4" />
              <span>{t('nav.logout')}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
