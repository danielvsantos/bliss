import { useState, type ComponentProps } from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useInstallPrompt } from '@/hooks/use-install-prompt';
import { InstallInstructionsDrawer } from './install-instructions-drawer';

/**
 * "Install app" control (#155). iOS: opens the Add to Home Screen steps.
 * Android / desktop Chrome: the native one-tap prompt. Renders nothing when
 * already installed or when the browser can do neither.
 */
type InstallAppButtonProps = Pick<ComponentProps<typeof Button>, 'variant' | 'size' | 'className'>;

export function InstallAppButton({ variant = 'outline', size = 'sm', className }: InstallAppButtonProps) {
  const { t } = useTranslation();
  const { mode, install } = useInstallPrompt();
  const [instructionsOpen, setInstructionsOpen] = useState(false);

  if (mode !== 'ios-instructions' && mode !== 'prompt') return null;

  const onClick = () => {
    if (mode === 'ios-instructions') setInstructionsOpen(true);
    else void install();
  };

  return (
    <>
      <Button variant={variant} size={size} className={className} onClick={onClick}>
        <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden />
        {t('pwa.install.button')}
      </Button>
      {mode === 'ios-instructions' && (
        <InstallInstructionsDrawer open={instructionsOpen} onOpenChange={setInstructionsOpen} />
      )}
    </>
  );
}
