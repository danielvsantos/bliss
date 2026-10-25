import { Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/**
 * Shown instead of every "Connect bank" / "Reconnect" action in the installed
 * app (#155): Plaid Link and the Enable Banking consent page leave the app's
 * scope, so iOS would run them in a browser sheet that does not share the
 * app's session. Reviewing already-synced transactions keeps working.
 */
export function DesktopOnlyBankNote({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <p
      data-testid="desktop-only-bank-note"
      className={cn('flex items-center gap-2 text-sm text-muted-foreground', className)}
    >
      <Monitor className="h-4 w-4 shrink-0" aria-hidden />
      {t('pwa.banks.desktopOnly')}
    </p>
  );
}
