import { useState } from "react";
import axios from "axios";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import api from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type ReauthMethod = "password" | "google";

interface ConfirmIdentityDialogProps {
  open: boolean;
  /** From GET /api/auth/reauth: password if the user has one, Google if linked and enabled. */
  methods: ReauthMethod[];
  /** Where the Google step-up lands afterwards (defaults to the current page). */
  returnTo?: string;
  onConfirmed: () => void;
  onCancel: () => void;
}

const T = "pages.login.confirm_identity";

/**
 * Recent sign-in step-up (#156, R19). Creating an integration or a key, or
 * approving an AI-agent connection, needs a sign-in within 15 minutes: the
 * user confirms with their password, or repeats Google sign-in (full
 * redirect, back to `returnTo`). The same methods are offered in the browser
 * and in the installed app — #155 Phase 2 kept Google Sign-In there.
 * A wrong password never ends the session.
 */
export function ConfirmIdentityDialog({ open, methods, returnTo, onConfirmed, onCancel }: ConfirmIdentityDialogProps) {
  const { t } = useTranslation();
  const { signInWithGoogle } = useAuth();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const hasPassword = methods.includes("password");
  const hasGoogle = methods.includes("google");

  function reset() {
    setPassword("");
    setError(null);
    setSubmitting(false);
  }

  function handleOpenChange(value: boolean) {
    if (!value) {
      reset();
      onCancel();
    }
  }

  async function confirmPassword() {
    if (!password) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.reauthWithPassword(password);
      reset();
      onConfirmed();
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      setError(t(status === 401 ? `${T}.wrong_password` : `${T}.error`));
      setSubmitting(false);
    }
  }

  function continueWithGoogle() {
    const path = returnTo ?? `${window.location.pathname}${window.location.search}`;
    void signInWithGoogle({ returnTo: path, prompt: "select_account" });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="confirm-identity-dialog">
        <DialogHeader>
          <DialogTitle>{t(`${T}.title`)}</DialogTitle>
          <DialogDescription>{t(`${T}.description`)}</DialogDescription>
        </DialogHeader>

        {hasPassword && (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void confirmPassword();
            }}
          >
            <Label htmlFor="confirm-identity-password">{t(`${T}.password_label`)}</Label>
            <Input
              id="confirm-identity-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error ? true : undefined}
            />
            {error && (
              <p className="text-sm text-destructive" role="alert">{error}</p>
            )}
          </form>
        )}

        {hasPassword && hasGoogle && (
          <p className="text-center text-xs text-muted-foreground">{t(`${T}.divider`)}</p>
        )}

        {hasGoogle && (
          <Button type="button" variant="outline" className="w-full" onClick={continueWithGoogle}>
            {t(`${T}.google`)}
          </Button>
        )}

        {!hasPassword && !hasGoogle && (
          <p className="text-sm text-muted-foreground" role="note">{t(`${T}.no_method`)}</p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          {hasPassword && (
            <Button type="button" onClick={() => void confirmPassword()} disabled={submitting || !password}>
              {submitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t(`${T}.confirm`)}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
