import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ExternalLink, Globe, Landmark, Settings2 } from 'lucide-react';

import { PlaidConnect, type PlaidUnavailableReason } from '@/components/plaid-connect';
import { EnableBankingConnectDialog } from '@/components/enable-banking/connect-dialog';
import { EnableBankingSetupDialog } from '@/components/onboarding/enable-banking-setup-dialog';
import { DesktopOnlyBankNote } from '@/components/pwa/desktop-only-bank-note';
import { useEnableBankingStatus } from '@/hooks/use-enable-banking';
import { useIsStandalone } from '@/hooks/use-display-mode';
import { ENABLE_BANKING_GUIDE_URL, PLAID_GUIDE_URL } from '@/lib/guide-links';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

const T = 'onboarding.connect';

interface BankProviderOptionsProps {
  /** Plaid finished (account selection closed). */
  onPlaidComplete: () => Promise<void>;
  /** Awaited just before leaving for the Enable Banking consent page. */
  onEnableBankingRedirect: () => Promise<void>;
}

function LearnMore({ href }: { href: string }) {
  const { t } = useTranslation();
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs text-brand-primary hover:underline"
    >
      {t(`${T}.learnMore`)}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

function ProviderCard({
  testId,
  icon,
  title,
  description,
  guideUrl,
  children,
}: {
  testId: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  guideUrl: string;
  children: React.ReactNode;
}) {
  // Both providers share this exact card: equal weight, no "primary" option.
  return (
    <div className="flex flex-col rounded-xl border p-4" data-testid={testId}>
      <div className="mb-3 flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-primary/10 text-brand-primary">
          {icon}
        </div>
        <div className="space-y-1">
          <h4 className="text-sm font-semibold">{title}</h4>
          <p className="text-xs text-muted-foreground">{description}</p>
          <LearnMore href={guideUrl} />
        </div>
      </div>
      <div className="mt-auto">{children}</div>
    </div>
  );
}

function PlaidUnavailable({ reason }: { reason: PlaidUnavailableReason }) {
  const { t } = useTranslation();
  if (reason === 'not_configured') {
    return (
      <div className="rounded-lg border bg-muted/50 p-3 text-xs" data-testid="plaid-not-configured">
        <p className="font-medium text-foreground">{t(`${T}.plaid.notConfigured`)}</p>
        <p className="mt-1 text-muted-foreground">{t(`${T}.plaid.notConfiguredHint`)}</p>
      </div>
    );
  }
  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/10 p-3 text-xs text-warning"
      data-testid="plaid-unreachable"
      role="status"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{t(`${T}.plaid.error`)}</span>
    </div>
  );
}

function EnableBankingAction({ onRedirect }: { onRedirect: () => Promise<void> }) {
  const { t } = useTranslation();
  const isStandalone = useIsStandalone();
  const { data: status, isLoading } = useEnableBankingStatus(!isStandalone);
  const [setupOpen, setSetupOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);

  // Installed app (#155): no consent redirects from here.
  if (isStandalone) return <DesktopOnlyBankNote />;
  if (isLoading) return <Skeleton className="h-10 w-full rounded-lg" />;

  const enabled = status?.enabled === true;
  const configurable = status?.configurable !== false;

  return (
    <>
      {enabled ? (
        <Button type="button" className="w-full rounded-lg" onClick={() => setConnectOpen(true)}>
          <Globe className="mr-2 h-4 w-4" />
          {t(`${T}.enableBanking.connect`)}
        </Button>
      ) : configurable ? (
        <Button type="button" className="w-full rounded-lg" onClick={() => setSetupOpen(true)}>
          <Settings2 className="mr-2 h-4 w-4" />
          {t(`${T}.enableBanking.setup`)}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">{t(`${T}.enableBanking.adminOnly`)}</p>
      )}

      {setupOpen && (
        <EnableBankingSetupDialog
          open={setupOpen}
          onOpenChange={setSetupOpen}
          onVerified={() => {
            // Straight on to the bank picker, without another click on step 2.
            setSetupOpen(false);
            setConnectOpen(true);
          }}
        />
      )}
      {connectOpen && (
        <EnableBankingConnectDialog open={connectOpen} onOpenChange={setConnectOpen} onBeforeRedirect={onRedirect} />
      )}
    </>
  );
}

/**
 * Onboarding step 2 (#154): Plaid and Enable Banking side by side, always in
 * this order and with the same emphasis (no ranking by country).
 */
export function BankProviderOptions({ onPlaidComplete, onEnableBankingRedirect }: BankProviderOptionsProps) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="bank-provider-options">
      <ProviderCard
        testId="provider-plaid"
        icon={<Landmark className="h-4 w-4" />}
        title={t(`${T}.plaid.title`)}
        description={t(`${T}.plaid.description`)}
        guideUrl={PLAID_GUIDE_URL}
      >
        <PlaidConnect
          className="w-full rounded-lg"
          onComplete={onPlaidComplete}
          renderUnavailable={(reason) => <PlaidUnavailable reason={reason} />}
        >
          {t(`${T}.plaid.button`)}
        </PlaidConnect>
      </ProviderCard>

      <ProviderCard
        testId="provider-enable-banking"
        icon={<Globe className="h-4 w-4" />}
        title={t(`${T}.enableBanking.title`)}
        description={t(`${T}.enableBanking.description`)}
        guideUrl={ENABLE_BANKING_GUIDE_URL}
      >
        <EnableBankingAction onRedirect={onEnableBankingRedirect} />
      </ProviderCard>
    </div>
  );
}
