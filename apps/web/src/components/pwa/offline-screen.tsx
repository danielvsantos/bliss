import { WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

/**
 * Rendered instead of the page when the device is offline (#155). It shows
 * no figures at all: the service worker caches only the app shell, and the
 * persisted query cache must not be presented as current.
 */
export function OfflineScreen() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      data-testid="offline-screen"
      className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <WifiOff className="h-10 w-10 text-muted-foreground" aria-hidden />
      <h2 className="text-xl font-semibold text-foreground">{t('pwa.offline.title')}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{t('pwa.offline.description')}</p>
      <Button variant="outline" onClick={() => window.location.reload()}>
        {t('pwa.offline.retry')}
      </Button>
    </div>
  );
}
