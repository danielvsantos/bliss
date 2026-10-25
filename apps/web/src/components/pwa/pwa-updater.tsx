import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';
import { PWA_NEED_REFRESH_EVENT, applyPwaUpdate } from '@/lib/pwa/register';

/**
 * Shows the "New version available — Reload" toast when a new build is
 * waiting after the launch window (#155, see lib/pwa/register.ts). Mounted
 * once in App.tsx. Ignoring the toast is safe: the next cold open runs the
 * new build.
 */
export function PwaUpdater() {
  const { t } = useTranslation();

  useEffect(() => {
    const onNeedRefresh = () => {
      toast({
        description: t('notifications.info.newVersion'),
        duration: Infinity,
        action: (
          <ToastAction altText={t('pwa.update.reload')} onClick={() => void applyPwaUpdate()}>
            {t('pwa.update.reload')}
          </ToastAction>
        ),
      });
    };
    window.addEventListener(PWA_NEED_REFRESH_EVENT, onNeedRefresh);
    return () => window.removeEventListener(PWA_NEED_REFRESH_EVENT, onNeedRefresh);
  }, [t]);

  return null;
}
