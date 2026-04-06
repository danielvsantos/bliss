import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDivider } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { EnrichedAccount } from '@/hooks/use-account-list';

/* ── Account Type Icons (from UIKit) ── */

function BankIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden="true">
      <path d="M2 14.5h13M2 7h13M8.5 2L15 5.5H2L8.5 2z"
        stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M4.5 7v5.5M8.5 7v5.5M12.5 7v5.5"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function CardTypeIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden="true">
      <rect x="2" y="4.5" width="13" height="9" rx="1.75"
        stroke="currentColor" strokeWidth="1.4" />
      <path d="M2 8h13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M4.5 11.5h2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function InvestIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden="true">
      <path d="M2 12.5l3.5-3.5 3 2.5 4-5.5 2.5 2"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 5.5h3v3"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WalletIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden="true">
      <rect x="2" y="4" width="13" height="10" rx="1.75"
        stroke="currentColor" strokeWidth="1.4" />
      <path d="M2 7.5h13" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="10.5" r="1" fill="currentColor" />
    </svg>
  );
}

/* ── Account Type Mapping ── */

type AccountTypeConfig = {
  icon: React.ReactNode;
  colorClass: string;
  bgClass: string;
  borderClass: string;
};

function getAccountTypeConfig(plaidType: string | null | undefined): AccountTypeConfig {
  switch (plaidType) {
    case 'depository':
      return {
        icon: <BankIcon />,
        colorClass: 'text-brand-deep',
        bgClass: 'bg-brand-deep/[0.08]',
        borderClass: 'border-brand-deep/[0.14]',
      };
    case 'credit':
      return {
        icon: <CardTypeIcon />,
        colorClass: 'text-brand-primary',
        bgClass: 'bg-brand-primary/[0.08]',
        borderClass: 'border-brand-primary/[0.14]',
      };
    case 'investment':
    case 'brokerage':
      return {
        icon: <InvestIcon />,
        colorClass: 'text-positive',
        bgClass: 'bg-positive/[0.08]',
        borderClass: 'border-positive/[0.14]',
      };
    default:
      return {
        icon: <WalletIcon />,
        colorClass: 'text-muted-foreground',
        bgClass: 'bg-muted',
        borderClass: 'border-muted-foreground/20',
      };
  }
}

/* ── Account Row ── */

function AccountRow({ account }: { account: EnrichedAccount }) {
  const plaidType = account.plaidItem?.accounts?.[0]?.type ?? null;
  const config = getAccountTypeConfig(plaidType);

  return (
    <div className="flex items-center gap-3 py-2.5">
      {/* Icon container */}
      <div className={`w-[38px] h-[38px] rounded-[10px] ${config.bgClass} border ${config.borderClass} flex items-center justify-center shrink-0 ${config.colorClass}`}>
        {config.icon}
      </div>

      {/* Name + sub info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate leading-snug">
          {account.accountName}
        </p>
        <p className="text-xs text-muted-foreground tracking-wide">
          {account.mask && `${account.mask} · `}{account.currencyCode}
        </p>
      </div>
    </div>
  );
}

/* ── Status Badge ── */

function StatusBadge({ accounts, t }: { accounts: EnrichedAccount[]; t: (key: string) => string }) {
  const allSynced = accounts.length > 0 && accounts.every(a => a.status === 'synced');
  const hasActionRequired = accounts.some(a => a.status === 'action-required');

  if (allSynced) {
    return (
      <div className="flex items-center gap-1.5 bg-positive/[0.08] border border-positive/[0.18] rounded-md px-2 py-0.5 shrink-0">
        <div className="w-1.5 h-1.5 rounded-full bg-positive" />
        <span className="text-[0.6875rem] font-semibold text-positive tracking-wide">{t('dashboard.live')}</span>
      </div>
    );
  }

  if (hasActionRequired) {
    return (
      <div className="flex items-center gap-1.5 bg-warning/[0.08] border border-warning/[0.18] rounded-md px-2 py-0.5 shrink-0">
        <div className="w-1.5 h-1.5 rounded-full bg-warning" />
        <span className="text-[0.6875rem] font-semibold text-warning tracking-wide">{t('dashboard.actionNeeded')}</span>
      </div>
    );
  }

  return null;
}

/* ── Synced Accounts Card ── */

interface SyncedAccountsCardProps {
  accounts: EnrichedAccount[];
  isLoading: boolean;
  className?: string;
}

export function SyncedAccountsCard({ accounts, isLoading, className }: SyncedAccountsCardProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const displayAccounts = accounts.slice(0, 3);
  const connectedCount = accounts.filter(a => a.status === 'synced').length;
  const allCurrent = connectedCount === accounts.length && accounts.length > 0;

  if (isLoading) {
    return (
      <Card className={`h-full ${className ?? ''}`}>
        <div className="p-6 space-y-4">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-3 w-48" />
          <div className="space-y-3 mt-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className={`h-full ${className ?? ''}`}>
      <CardHeader>
        <div className="flex items-center justify-between w-full">
          <div className="flex flex-col gap-0.5">
            <CardTitle className="text-lg font-medium">{t('dashboard.syncedAccounts')}</CardTitle>
            <span className="text-[0.8125rem] text-muted-foreground">
              {accounts.length} {t('dashboard.connected')}{allCurrent ? ` · ${t('dashboard.allCurrent')}` : ''}
            </span>
          </div>
          <StatusBadge accounts={accounts} t={t} />
        </div>
      </CardHeader>

      <CardDivider />

      {/* Account rows */}
      <div className="flex flex-col px-6">
        {displayAccounts.map((acc, i) => (
          <div key={acc.id}>
            <AccountRow account={acc} />
            {i < displayAccounts.length - 1 && (
              <div className="h-px bg-border/60 ml-[50px]" />
            )}
          </div>
        ))}
        {accounts.length === 0 && (
          <p className="text-sm text-muted-foreground py-4 text-center">
            {t('dashboard.noAccountsConnected')}
          </p>
        )}
      </div>

      <CardDivider />

      {/* Footer */}
      <div className="px-6 pb-6">
        <button
          onClick={() => navigate('/accounts')}
          className="flex items-center gap-1 text-[0.8125rem] font-medium text-brand-primary hover:text-brand-deep transition-colors cursor-pointer"
        >
          {t('dashboard.connectMoreAccounts')}
          <ChevronRight size={14} />
        </button>
      </div>
    </Card>
  );
}
