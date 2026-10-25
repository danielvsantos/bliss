import { Smartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/card';
import { useInstallPrompt } from '@/hooks/use-install-prompt';
import { InstallAppButton } from './install-app-button';

/** Settings → General: the always-available install control (#155). */
export function InstallAppCard() {
  const { t } = useTranslation();
  const { mode } = useInstallPrompt();
  if (mode !== 'ios-instructions' && mode !== 'prompt') return null;

  return (
    <Card className="overflow-hidden p-0 gap-0" data-testid="install-app-card">
      <div className="flex flex-col gap-3 px-5 sm:px-7 py-[18px] sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-brand-primary" aria-hidden />
          <div>
            <h3 className="text-lg font-medium text-foreground tracking-[-0.01em]">
              {t('pwa.install.settingsTitle')}
            </h3>
            <p className="text-[0.8125rem] text-muted-foreground mt-1 leading-relaxed">
              {t('pwa.install.settingsDescription')}
            </p>
          </div>
        </div>
        <InstallAppButton />
      </div>
    </Card>
  );
}
