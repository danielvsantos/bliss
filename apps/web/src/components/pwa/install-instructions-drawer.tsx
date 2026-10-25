import { Share, SquarePlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';

interface InstallInstructionsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * iOS has no install prompt: these are the Share → Add to Home Screen steps
 * (#155). Ends with the sign-in note — the installed app has its own cookie
 * store, so the user signs in once inside it.
 */
export function InstallInstructionsDrawer({ open, onOpenChange }: InstallInstructionsDrawerProps) {
  const { t } = useTranslation();
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent data-testid="install-instructions">
        <DrawerHeader className="text-left">
          <DrawerTitle>{t('pwa.install.iosTitle')}</DrawerTitle>
          <DrawerDescription className="sr-only">{t('pwa.install.iosTitle')}</DrawerDescription>
        </DrawerHeader>
        <ol className="space-y-3 px-4 text-sm text-foreground">
          <li className="flex items-start gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-primary/10 text-xs font-medium text-brand-primary">1</span>
            <span className="pt-0.5">
              {t('pwa.install.iosStep1')} <Share className="inline h-4 w-4 align-text-bottom" aria-hidden />
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-primary/10 text-xs font-medium text-brand-primary">2</span>
            <span className="pt-0.5">
              {t('pwa.install.iosStep2')} <SquarePlus className="inline h-4 w-4 align-text-bottom" aria-hidden />
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-primary/10 text-xs font-medium text-brand-primary">3</span>
            <span className="pt-0.5">{t('pwa.install.iosStep3')}</span>
          </li>
        </ol>
        <p className="mx-4 mt-4 rounded-[0.75rem] border border-brand-primary/20 bg-brand-primary/10 px-3 py-2 text-sm text-brand-primary">
          {t('pwa.install.iosSignInNote')}
        </p>
        <DrawerFooter>
          <DrawerClose asChild>
            <Button variant="outline">{t('pwa.install.done')}</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
