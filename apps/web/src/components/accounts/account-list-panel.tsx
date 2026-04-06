import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Search, Landmark, CreditCard, Wallet, DollarSign, Building, ChevronDown } from 'lucide-react';
import type { EnrichedAccount } from '@/hooks/use-account-list';

interface AccountListPanelProps {
  accounts: EnrichedAccount[];
  selectedAccountId: number | null;
  onSelectAccount: (id: number) => void;
  isLoading: boolean;
}

// Icon based on institution name
function getAccountIcon(institution: string) {
  const name = institution.toLowerCase();
  if (name.includes('credit') || name.includes('card')) return <CreditCard className="h-4 w-4" />;
  if (name.includes('cash') || name.includes('wallet')) return <Wallet className="h-4 w-4" />;
  if (name.includes('investment') || name.includes('stock')) return <DollarSign className="h-4 w-4" />;
  if (name.includes('business')) return <Building className="h-4 w-4" />;
  return <Landmark className="h-4 w-4" />;
}

function StatusBadge({ status }: { status: EnrichedAccount['status'] }) {
  const { t } = useTranslation();
  const config = {
    synced: { label: t('accountsPage.synced'), variant: 'default' as const, className: 'bg-positive/10 text-positive border-positive/20 hover:bg-positive/10' },
    'action-required': { label: t('accountsPage.actionRequired'), variant: 'default' as const, className: 'bg-warning/10 text-warning border-warning/20 hover:bg-warning/10' },
    disconnected: { label: t('accountsPage.disconnected'), variant: 'default' as const, className: 'bg-muted text-muted-foreground border-border hover:bg-muted' },
    manual: { label: t('accountsPage.manual'), variant: 'secondary' as const, className: '' },
  }[status];

  return (
    <Badge variant={config.variant} className={`text-[10px] font-medium px-1.5 py-0 ${config.className}`}>
      {config.label}
    </Badge>
  );
}

export function AccountListPanel({ accounts, selectedAccountId, onSelectAccount, isLoading }: AccountListPanelProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search.trim()) return accounts;
    const q = search.toLowerCase();
    return accounts.filter(
      (a) =>
        a.accountName.toLowerCase().includes(q) ||
        a.institution.toLowerCase().includes(q) ||
        a.mask.includes(q),
    );
  }, [accounts, search]);

  // Group accounts by bank name — all accounts under the same bank stay together
  // regardless of Plaid sync status (the badge distinguishes synced vs manual)
  const groups = useMemo(() => {
    const map = new Map<string, EnrichedAccount[]>();
    for (const account of filtered) {
      const key = account.institution && account.institution !== 'Unknown'
        ? account.institution
        : 'Manual Accounts';
      const list = map.get(key);
      if (list) list.push(account);
      else map.set(key, [account]);
    }
    // Sort: Named banks first (alphabetical), "Manual Accounts" last
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === 'Manual Accounts') return 1;
      if (b === 'Manual Accounts') return -1;
      return a.localeCompare(b);
    });
  }, [filtered]);

  return (
    <div className="flex flex-col h-full border-r">
      {/* Search */}
      <div className="p-4 pb-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('accountsPage.searchAccounts')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9 text-sm"
          />
        </div>
      </div>

      <Separator />

      {/* Account list */}
      <ScrollArea className="flex-1">
        {isLoading ? (
          <div className="p-4 space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 bg-muted rounded-lg animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            {search ? t('accountsPage.noAccountsMatch') : t('accountsPage.noAccountsYet')}
          </div>
        ) : (
          <div className="py-1">
            {groups.map(([groupName, groupAccounts]) => (
              <Collapsible key={groupName} defaultOpen>
                <CollapsibleTrigger className="w-full flex items-center justify-between px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider hover:bg-muted/30 transition-colors group">
                  <span>{groupName} — {groupAccounts.length}</span>
                  <ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=closed]:-rotate-90" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {groupAccounts.map((account) => {
                    const isSelected = selectedAccountId === account.id;
                    return (
                      <button
                        key={account.id}
                        onClick={() => onSelectAccount(account.id)}
                        className={`w-full text-left px-4 py-3 flex items-center gap-3 transition-colors hover:bg-muted/50 ${
                          isSelected ? 'bg-muted border-l-2 border-l-primary' : ''
                        }`}
                      >
                        {/* Icon */}
                        <div className={`flex items-center justify-center w-9 h-9 rounded-full shrink-0 ${
                          isSelected ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                        }`}>
                          {getAccountIcon(account.institution)}
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium truncate">{account.accountName}</span>
                            <StatusBadge status={account.status} />
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-xs text-muted-foreground truncate">{account.institution}</span>
                            <span className="text-xs text-muted-foreground font-mono">{account.mask}</span>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
