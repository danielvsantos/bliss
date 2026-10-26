import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { CalendarDays, Globe, Landmark, Loader2, Search } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/use-auth';
import {
  enableBankingError,
  useConnectEnableBanking,
  useEnableBankingAspsps,
  useEnableBankingEnabled,
} from '@/hooks/use-enable-banking';
import { countryName, formatIsoDay } from '@/lib/enable-banking';
import type { EnableBankingAspsp } from '@/types/api';
import { useIsStandalone } from '@/hooks/use-display-mode';

interface EnableBankingConnectProps {
  variant?: 'default' | 'outline' | 'secondary' | 'ghost' | 'link';
  className?: string;
  children?: React.ReactNode;
}

const aspspKey = (a: Pick<EnableBankingAspsp, 'name' | 'country'>) => `${a.country}::${a.name}`;

/**
 * "Connect EU bank (Enable Banking)" entry point (#132). Renders nothing when
 * Enable Banking is not configured or for viewers. The dialog shows the bank
 * picker and the first import date, then navigates to the bank's consent page.
 */
export function EnableBankingConnect({ variant = 'outline', className, children }: EnableBankingConnectProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isViewer = user?.role === 'viewer';
  const enabled = useEnableBankingEnabled(!!user && !isViewer);
  const [open, setOpen] = useState(false);
  const isStandalone = useIsStandalone();

  // Installed app (#155): no consent redirects. Every page with this button
  // also renders <PlaidConnect />, whose desktop-only note covers both.
  if (!enabled || isStandalone) return null;

  return (
    <>
      <Button type="button" variant={variant} className={className} onClick={() => setOpen(true)}>
        {children ?? (
          <>
            <Globe className="mr-2 h-4 w-4" />
            {t('enableBanking.connect.button')}
          </>
        )}
      </Button>
      {open && <EnableBankingConnectDialog open={open} onOpenChange={setOpen} />}
    </>
  );
}

interface EnableBankingConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Awaited after the consent URL is returned and before leaving for the bank
   * (#154: onboarding records its completion here). Bound it yourself: the
   * redirect waits for it. The Accounts page passes nothing.
   */
  onBeforeRedirect?: () => Promise<void>;
}

export function EnableBankingConnectDialog({ open, onOpenChange, onBeforeRedirect }: EnableBankingConnectDialogProps) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language;
  const { toast } = useToast();
  const { data, isLoading, isError } = useEnableBankingAspsps(open);
  const connect = useConnectEnableBanking();
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState(false);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byCountry = new Map<string, EnableBankingAspsp[]>();
    for (const aspsp of data?.aspsps ?? []) {
      if (q && !aspsp.name.toLowerCase().includes(q)) continue;
      const list = byCountry.get(aspsp.country) ?? [];
      list.push(aspsp);
      byCountry.set(aspsp.country, list);
    }
    return [...byCountry.entries()]
      .map(([country, aspsps]) => ({ country, label: countryName(country, language), aspsps }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [data, query, language]);

  const selected = (data?.aspsps ?? []).find((a) => aspspKey(a) === selectedKey) ?? null;
  const consentDays = selected?.maximumConsentValiditySec
    ? Math.floor(selected.maximumConsentValiditySec / 86400)
    : null;

  const handleContinue = () => {
    if (!selected) return;
    connect.mutate(
      { aspspName: selected.name, aspspCountry: selected.country },
      {
        onSuccess: async ({ url }) => {
          setRedirecting(true);
          try {
            await onBeforeRedirect?.();
          } catch {
            // Never block the bank redirect on the caller's bookkeeping.
          }
          window.location.assign(url);
        },
        onError: (error) => {
          const { body } = enableBankingError(error);
          const description = body.code === 'COUNTRY_NOT_ENABLED'
            ? t('enableBanking.connect.errorCountryNotEnabled')
            : body.code === 'UNKNOWN_ASPSP'
              ? t('enableBanking.connect.errorUnknownBank')
              : t('enableBanking.connect.errorGeneric');
          toast({ title: t('common.error'), description, variant: 'destructive' });
        },
      },
    );
  };

  const busy = connect.isPending || redirecting;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('enableBanking.connect.title')}</DialogTitle>
          <DialogDescription>{t('enableBanking.connect.description')}</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('enableBanking.connect.loading')}
          </div>
        ) : isError || !data ? (
          <p className="py-6 text-sm text-destructive">{t('enableBanking.connect.loadFailed')}</p>
        ) : (
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('enableBanking.connect.search')}
                aria-label={t('enableBanking.connect.search')}
                className="pl-8"
              />
            </div>

            <div className="max-h-72 overflow-y-auto rounded-md border" role="listbox" aria-label={t('enableBanking.connect.title')}>
              {groups.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">{t('enableBanking.connect.noBanks')}</p>
              ) : (
                groups.map((group) => (
                  <div key={group.country}>
                    <div className="sticky top-0 bg-muted px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {group.label}
                    </div>
                    {group.aspsps.map((aspsp) => {
                      const key = aspspKey(aspsp);
                      const isSelected = key === selectedKey;
                      return (
                        <button
                          key={key}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          onClick={() => setSelectedKey(key)}
                          className={`flex w-full items-center gap-3 border-b px-3 py-2 text-left text-sm last:border-b-0 transition-colors ${
                            isSelected ? 'bg-accent font-medium' : 'hover:bg-accent/50'
                          }`}
                        >
                          {aspsp.logo ? (
                            <img src={aspsp.logo} alt="" className="h-6 w-6 shrink-0 rounded object-contain" loading="lazy" />
                          ) : (
                            <Landmark className="h-5 w-5 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate">{aspsp.name}</span>
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            {/* The first import date is shown before the user leaves for the bank. */}
            <div
              className="flex items-start gap-2 rounded-lg border border-brand-primary/20 bg-brand-primary/5 p-3 text-sm"
              data-testid="eb-start-date"
            >
              <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-brand-primary" />
              <div className="space-y-1">
                <p>
                  {t('enableBanking.connect.startDate')}{' '}
                  <strong>{formatIsoDay(data.startDate, language)}</strong>
                </p>
                {consentDays !== null && (
                  <p className="text-xs text-muted-foreground">
                    {t('enableBanking.connect.consentDays', { count: consentDays })}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleContinue} disabled={!selected || busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {busy ? t('enableBanking.connect.redirecting') : t('enableBanking.connect.continue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
