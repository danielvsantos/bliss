import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { AlertTriangle, KeyRound, Loader2, ShieldAlert } from 'lucide-react';

import api from '@/lib/api';
import { useAuth } from '@/hooks/use-auth';
import { withAuth } from '@/components/withAuth';
import { Logo } from '@/components/logo';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';
import type { IntegrationAccessLevel, KeyExpiryDays } from '@/types/integrations';

/**
 * OAuth consent (#89). Claude Cowork / claude.ai connectors send the user
 * here (via /api/oauth/authorize) to approve access to Bliss through the MCP
 * server. Approving creates an integration (#84) that shows up in Settings →
 * Integrations; the browser is then sent back to the app with a one-time code.
 */

const T = 'pages.oauth.consent';
const TI = 'pages.settings.integrations';

const EXPIRY_OPTIONS: { value: string; days: KeyExpiryDays; labelKey: string }[] = [
  { value: '30', days: 30, labelKey: 'form.expiry_30' },
  { value: '90', days: 90, labelKey: 'form.expiry_90' },
  { value: '365', days: 365, labelKey: 'form.expiry_365' },
  { value: 'never', days: null, labelKey: 'form.expiry_never' },
];

function errorText(error: unknown): string | null {
  if (axios.isAxiosError(error)) {
    const message = (error.response?.data as { error?: unknown } | undefined)?.error;
    if (typeof message === 'string') return message;
  }
  return null;
}

function OAuthConsentPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const requestId = new URLSearchParams(window.location.search).get('request') ?? '';
  const [accessLevel, setAccessLevel] = useState<IntegrationAccessLevel>('READ_ONLY');
  const [expiry, setExpiry] = useState('90');
  const [submitting, setSubmitting] = useState<'approve' | 'deny' | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const consent = useQuery({
    queryKey: ['oauth-consent', requestId],
    queryFn: () => api.getOAuthRequest(requestId),
    enabled: requestId.length > 0,
    retry: false,
    staleTime: Infinity,
  });

  // Never offer more than the app asked for.
  useEffect(() => {
    if (consent.data?.request.maxAccessLevel === 'READ_ONLY') setAccessLevel('READ_ONLY');
  }, [consent.data]);

  async function decide(kind: 'approve' | 'deny') {
    setSubmitting(kind);
    setSubmitError(null);
    try {
      const option = EXPIRY_OPTIONS.find((o) => o.value === expiry);
      const { redirectUrl } = kind === 'approve'
        ? await api.approveOAuthRequest(requestId, { accessLevel, expiresInDays: option ? option.days : 90 })
        : await api.denyOAuthRequest(requestId);
      window.location.assign(redirectUrl);
    } catch (error) {
      setSubmitError(errorText(error) ?? t(`${T}.error_generic`));
      setSubmitting(null);
    }
  }

  const loadError = !requestId
    ? t(`${T}.error_missing`)
    : consent.isError
      ? errorText(consent.error) ?? t(`${T}.error_generic`)
      : null;
  const request = consent.data?.request;
  const writeAllowed = request?.maxAccessLevel === 'READ_WRITE';

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <Card className="w-full max-w-md space-y-5 p-6 sm:p-8" data-testid="oauth-consent">
        <div className="flex justify-center">
          <Logo />
        </div>

        {consent.isLoading && (
          <div className="flex justify-center py-8" data-testid="oauth-consent-loading">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {loadError && (
          <div className="space-y-2 text-center" role="alert">
            <h1 className="text-lg font-semibold text-foreground">{t(`${T}.error_title`)}</h1>
            <p className="text-sm text-muted-foreground">{loadError}</p>
          </div>
        )}

        {request && (
          <>
            <div className="space-y-1 text-center">
              <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-brand-primary/10">
                <KeyRound className="h-5 w-5 text-brand-primary" />
              </div>
              <h1 className="text-lg font-semibold text-foreground">
                {t(`${T}.title`, { client: request.clientName })}
              </h1>
              <p className="text-sm text-muted-foreground">{t(`${T}.subtitle`)}</p>
              {user?.email && (
                <p className="text-xs text-muted-foreground">{t(`${T}.signed_in_as`, { email: user.email })}</p>
              )}
            </div>

            <p
              className="flex items-start gap-2 rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning"
              data-testid="oauth-redirect-host"
            >
              <ShieldAlert className="mt-px h-4 w-4 shrink-0" />
              <span>
                {t(`${T}.redirect_notice`)}{' '}
                <code className="break-words font-mono font-semibold">{request.redirectHost}</code>
              </span>
            </p>

            {consent.data?.canApprove ? (
              <>
                <div className="space-y-2">
                  <Label>{t(`${T}.access_label`)}</Label>
                  <RadioGroup
                    value={accessLevel}
                    onValueChange={(v) => setAccessLevel(v as IntegrationAccessLevel)}
                    className="gap-2"
                  >
                    {(['READ_ONLY', 'READ_WRITE'] as const).map((level) => {
                      const disabled = level === 'READ_WRITE' && !writeAllowed;
                      return (
                        <label
                          key={level}
                          htmlFor={`consent-access-${level}`}
                          className={cn(
                            'flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 transition-colors',
                            accessLevel === level && 'border-brand-primary bg-brand-primary/5',
                            disabled && 'cursor-not-allowed opacity-50',
                          )}
                        >
                          <RadioGroupItem id={`consent-access-${level}`} value={level} disabled={disabled} className="mt-0.5" />
                          <span className="space-y-0.5">
                            <span className="block text-sm font-medium text-foreground">
                              {t(level === 'READ_WRITE' ? `${TI}.access_read_write` : `${TI}.access_read_only`)}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {t(level === 'READ_WRITE' ? `${T}.read_write_description` : `${T}.read_only_description`)}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </RadioGroup>
                </div>

                <div className="space-y-2">
                  <Label>{t(`${T}.expiry_label`)}</Label>
                  <RadioGroup value={expiry} onValueChange={setExpiry} className="grid grid-cols-2 gap-2">
                    {EXPIRY_OPTIONS.map((option) => (
                      <label
                        key={option.value}
                        htmlFor={`consent-expiry-${option.value}`}
                        className={cn(
                          'flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm',
                          expiry === option.value && 'border-brand-primary bg-brand-primary/5',
                        )}
                      >
                        <RadioGroupItem id={`consent-expiry-${option.value}`} value={option.value} />
                        {t(`${TI}.${option.labelKey}`)}
                      </label>
                    ))}
                  </RadioGroup>
                  {expiry === 'never' && (
                    <p className="flex items-start gap-1.5 rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
                      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                      {t(`${T}.no_expiry_warning`)}
                    </p>
                  )}
                </div>

                <p className="text-xs text-muted-foreground">{t(`${T}.footnote`)}</p>
              </>
            ) : (
              <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground" role="note">
                {t(`${T}.admin_required`)}
              </p>
            )}

            {submitError && (
              <p className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
                {submitError}
              </p>
            )}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" disabled={submitting !== null} onClick={() => decide('deny')}>
                {submitting === 'deny' && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {t(`${T}.deny`)}
              </Button>
              {consent.data?.canApprove && (
                <Button type="button" disabled={submitting !== null} onClick={() => decide('approve')}>
                  {submitting === 'approve' && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                  {t(`${T}.allow`)}
                </Button>
              )}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

export { OAuthConsentPage };

/** Signed-in users only; signing in returns here (returnTo). */
const ProtectedOAuthConsentPage = withAuth(OAuthConsentPage);
export default ProtectedOAuthConsentPage;
