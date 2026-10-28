import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import api from "@/lib/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface SignOutOthersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const T = "pages.settings.general.sign_out_others";

/**
 * "Sign out of all other devices" (#156, R16). Every other browser and
 * installed app of this user is signed out on its next request; this device
 * stays signed in. Available to every role.
 */
export function SignOutOthersDialog({ open, onOpenChange }: SignOutOthersDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState(false);

  async function confirm() {
    setSubmitting(true);
    try {
      await api.signOutOtherDevices();
      toast({ title: t(`${T}.success`) });
      onOpenChange(false);
    } catch {
      toast({ title: t(`${T}.error`), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(`${T}.confirm_title`)}</AlertDialogTitle>
          <AlertDialogDescription>{t(`${T}.confirm_description`)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={submitting}
            onClick={(e) => {
              e.preventDefault();
              void confirm();
            }}
          >
            {submitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {t(`${T}.confirm`)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
