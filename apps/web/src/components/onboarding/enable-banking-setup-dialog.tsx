import { useTranslation } from 'react-i18next';
import { CheckCircle2, ExternalLink, Info } from 'lucide-react';

import { useEnableBankingCredentials } from '@/hooks/use-enable-banking-credentials';
import { ENABLE_BANKING_GUIDE_URL } from '@/lib/guide-links';
import { CredentialsForm } from '@/components/settings/enable-banking-credentials-form';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

import type { EnableBankingCredentialsView } from '@/types/api';

const T = 'onboarding.connect.setup';

interface EnableBankingSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The saved credential was verified: the caller opens the connect dialog. */
  onVerified: (view: EnableBankingCredentialsView) => void;
}

/**
 * Enable Banking setup inside onboarding (#154). Wraps the Settings → Bank
 * sync form (#148), so the key is handled in one place: it lives in the form's
 * state only and unmounts with this dialog.
 */
export function EnableBankingSetupDialog({ open, onOpenChange, onVerified }: EnableBankingSetupDialogProps) {
  const { t } = useTranslation();
  const { data: view, isLoading, isError } = useEnableBankingCredentials(open);

  const needs = [`${T}.needAccount`, `${T}.needApp`, `${T}.needCallback`];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t(`${T}.title`)}</DialogTitle>
          <DialogDescription>{t(`${T}.description`)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2 rounded-lg border bg-muted/50 p-3 text-sm" data-testid="eb-setup-needs">
          <p className="font-medium">{t(`${T}.needTitle`)}</p>
          <ul className="space-y-1">
            {needs.map((key) => (
              <li key={key} className="flex items-start gap-2 text-muted-foreground">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-primary" />
                <span>{t(key)}</span>
              </li>
            ))}
          </ul>
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t(`${T}.limit`)}</span>
          </p>
          <a
            href={ENABLE_BANKING_GUIDE_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-brand-primary hover:underline"
          >
            {t(`${T}.guide`)}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : isError || !view ? (
          <p className="text-sm text-destructive">{t('enableBanking.credentials.loadFailed')}</p>
        ) : (
          <CredentialsForm
            view={view}
            initialAppId=""
            onCancel={() => onOpenChange(false)}
            onSaved={(saved) => {
              // Only a verified app goes straight on to the bank picker; an
              // unverified save is explained by the form's toast.
              if (saved.credential?.status === 'VERIFIED') onVerified(saved);
              else onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
