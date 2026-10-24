import { useState } from 'react';
import { Smartphone, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useInstallPrompt } from '@/hooks/use-install-prompt';
import { cn } from '@/lib/utils';
import { InstallAppButton } from './install-app-button';

export const INSTALL_BANNER_DISMISSED_KEY = 'bliss.pwa.installBannerDismissed';

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(INSTALL_BANNER_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Dashboard invitation to install Bliss (#155). Dismissal is permanent on
 * this device (PRD D8); Settings keeps the install control.
 */
export function InstallBanner({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { mode } = useInstallPrompt();
  const [dismissed, setDismissed] = useState(readDismissed);

  if (dismissed || (mode !== 'ios-instructions' && mode !== 'prompt')) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(INSTALL_BANNER_DISMISSED_KEY, '1');
    } catch {
      // Storage blocked: hide for this session only.
    }
    setDismissed(true);
  };

  return (
    <div
      data-testid="install-banner"
      className={cn(
        'flex items-center gap-3 rounded-[0.75rem] border border-brand-primary/20 bg-brand-primary/10 px-3 py-2',
        className,
      )}
    >
      <Smartphone className="h-5 w-5 shrink-0 text-brand-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{t('pwa.install.bannerTitle')}</p>
        <p className="text-xs text-muted-foreground">{t('pwa.install.bannerDescription')}</p>
      </div>
      <InstallAppButton />
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        aria-label={t('pwa.install.dismiss')}
        onClick={dismiss}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
