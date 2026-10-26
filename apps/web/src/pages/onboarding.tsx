import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { TypeAnimation } from "react-type-animation";
import { useToast } from "@/hooks/use-toast";
import { useOnboarding } from "@/hooks/use-onboarding";
import api from "@/lib/api";
import type { TenantUpdateRequest } from "@/types/api";
import { updateTenantMetaFromAPI, getTenantMeta } from "@/utils/tenantMetaStorage";
import { useAuth } from "@/hooks/use-auth";
import { useMetadata } from "@/hooks/use-metadata";
import { useCompleteOnboardingStep } from "@/hooks/use-onboarding-progress";
import { BankProviderOptions } from "@/components/onboarding/bank-provider-options";
import { OnboardingAccountSetup } from "@/components/onboarding/onboarding-account-setup";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  ArrowRight,
  ArrowLeft,
  X,
  Loader2,
  Building2,
  FileSpreadsheet,
  Wallet,
} from "lucide-react";

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1, duration: 0.3 },
  },
  exit: { opacity: 0, transition: { duration: 0.3 } },
};

const itemVariants = {
  hidden: { y: 20, opacity: 0 },
  visible: { y: 0, opacity: 1, transition: { duration: 0.3 } },
};

/** Upper bound on recording onboarding completion before the bank redirect. */
const ENABLE_BANKING_COMPLETION_TIMEOUT_MS = 5000;

export default function OnboardingPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { currentStep, setCurrentStep, preferences, setCountries, setCurrencies } = useOnboarding();
  const { data: metadata } = useMetadata();
  const completeStep = useCompleteOnboardingStep();

  const [isLoading, setIsLoading] = useState(false);
  const [welcomeAnimDone, setWelcomeAnimDone] = useState(false);
  const [connectAnimDone, setConnectAnimDone] = useState(false);
  const [connectMethod, setConnectMethod] = useState<"csv" | null>(null);

  // Country & currency selection (both multi-select)
  const [selectedCountries, setSelectedCountries] = useState<string[]>([]);
  const [selectedCurrencies, setSelectedCurrencies] = useState<string[]>([]);

  const countries = useMemo(
    () => metadata?.countries?.map((c) => ({ id: c.id, name: c.name, emoji: c.emoji || "🌐" })) || [],
    [metadata]
  );

  const currencies = useMemo(
    () => metadata?.currencies?.map((c) => ({ id: c.id, name: c.name, symbol: c.symbol || "¤" })) || [],
    [metadata]
  );

  // Country the onboarding-scaffolded draft accounts are created in: the tenant's
  // primary (isDefault) country set in step 1, falling back to the first country
  // the user picked this session.
  const primaryCountryId = useMemo(() => {
    const metaCountries = getTenantMeta()?.countries || [];
    const defaultCountry = metaCountries.find((c) => c.isDefault) || metaCountries[0];
    return defaultCountry?.id || preferences.countries[0] || selectedCountries[0] || "";
  }, [preferences.countries, selectedCountries]);

  const toggleCountry = (id: string) => {
    setSelectedCountries((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  };

  const toggleCurrency = (id: string) => {
    setSelectedCurrencies((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  };

  const getTenantId = () => {
    let tenantId = user?.tenant?.id || user?.tenantId;
    if (!tenantId) {
      const tenantMeta = getTenantMeta();
      tenantId = tenantMeta?.id;
    }
    return tenantId;
  };

  // Step 1: Save profile (country + currencies) then advance
  const saveProfileAndContinue = async () => {
    setIsLoading(true);
    try {
      const tenantId = getTenantId();
      if (!tenantId) throw new Error(t("onboarding.errors.noTenant"));

      const tenantMeta = getTenantMeta();
      const name = tenantMeta?.name;
      const plan = tenantMeta?.plan;
      if (!name || !plan) throw new Error(t("onboarding.errors.tenantMissing"));

      // Build payload — countries as array, currencies as array
      const payload: TenantUpdateRequest = { name, plan };
      if (selectedCountries.length > 0) payload.countries = selectedCountries;
      if (selectedCurrencies.length > 0) payload.currencies = selectedCurrencies;

      await api.updateTenant(tenantId, payload);
      await updateTenantMetaFromAPI(tenantId);

      // Update onboarding context
      setCountries(selectedCountries);
      setCurrencies(selectedCurrencies);

      // Mark step1 complete on server
      completeStep.mutate({ step: "step1_profile" });

      setCurrentStep("connect");
    } catch (error) {
      toast({
        title: t("common.error"),
        description: (error as Error).message || t("onboarding.errors.savePreferences"),
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Enable Banking (#154): leaving for the bank's consent page ends onboarding.
  // Sequential writes (the progress PUT is read-modify-write), awaited before
  // the redirect because unloading the page cancels in-flight requests, and
  // capped so a hung request never keeps the user from their bank.
  const recordEnableBankingCompletion = () => {
    const record = async () => {
      try {
        await api.completeOnboardingStep("step2_connect", { method: "enable_banking" });
      } catch {
        // Bookkeeping only: never block the redirect.
      }
      try {
        await api.completeOnboardingStep("setupComplete");
      } catch {
        // As above.
      }
    };
    return Promise.race([
      record(),
      new Promise<void>((resolve) => setTimeout(resolve, ENABLE_BANKING_COMPLETION_TIMEOUT_MS)),
    ]);
  };

  // Complete onboarding and redirect
  const finishOnboarding = async (redirectTo: string) => {
    try {
      await api.completeOnboardingStep("setupComplete");
      navigate(redirectTo);
    } catch {
      // Even if the API call fails, still navigate
      navigate(redirectTo);
    }
  };

  return (
    <div className="fixed inset-0 bg-gradient-to-br from-brand-primary/10 to-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto">
      <Card className={`w-full ${currentStep === "connect" ? "max-w-2xl" : "max-w-xl"} mx-auto shadow-xl`} style={{ background: 'hsl(var(--card))', backdropFilter: 'none', WebkitBackdropFilter: 'none' }}>
        <CardContent className="p-6 md:p-8">
          <AnimatePresence mode="wait">
            {/* ═══════════════════════════════════════════════ */}
            {/* Step 1: Welcome + Profile                      */}
            {/* ═══════════════════════════════════════════════ */}
            {currentStep === "welcome" && (
              <motion.div
                key="welcome"
                className="space-y-6"
                variants={containerVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                <motion.div className="text-center mb-4" variants={itemVariants}>
                  <h2 className="text-3xl font-bold mb-2">
                    {t("onboarding.welcome.title")} <span className="text-brand-primary">bliss</span>
                  </h2>
                  <div className="min-h-8">
                    <TypeAnimation
                      sequence={[
                        t("onboarding.welcome.subtitle"),
                        () => setWelcomeAnimDone(true),
                      ]}
                      speed={30}
                      style={{ fontFamily: "Urbanist", display: "inline-block" }}
                      cursor={false}
                    />
                  </div>
                </motion.div>

                {welcomeAnimDone && (
                  <>
                    {/* Country picker (multi-select) */}
                    <motion.div variants={itemVariants}>
                      <label className="text-sm font-medium mb-2 block">
                        {t("onboarding.welcome.countries")}
                      </label>
                      <div className="grid grid-cols-4 sm:grid-cols-5 gap-2 max-h-40 overflow-y-auto pr-1">
                        {countries.map((c) => (
                          <button
                            key={c.id}
                            onClick={() => toggleCountry(c.id)}
                            className={`flex flex-col items-center p-2 rounded-lg border text-xs transition-all ${
                              selectedCountries.includes(c.id)
                                ? "border-brand-primary bg-brand-primary/10 ring-1 ring-brand-primary/30"
                                : "border-border hover:bg-accent"
                            }`}
                          >
                            <span className="text-xl mb-1">{c.emoji}</span>
                            <span className="truncate w-full text-center">{c.name}</span>
                          </button>
                        ))}
                      </div>
                    </motion.div>

                    {/* Currency picker */}
                    <motion.div variants={itemVariants}>
                      <label className="text-sm font-medium mb-2 block">
                        {t("onboarding.welcome.currencies")}
                      </label>
                      <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto pr-1">
                        {currencies.map((c) => (
                          <button
                            key={c.id}
                            onClick={() => toggleCurrency(c.id)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm transition-all ${
                              selectedCurrencies.includes(c.id)
                                ? "border-brand-primary bg-brand-primary/10 text-brand-primary"
                                : "border-border hover:bg-accent"
                            }`}
                          >
                            <span>{c.symbol}</span>
                            <span>{c.id}</span>
                            {selectedCurrencies.includes(c.id) && (
                              <X className="h-3 w-3 ml-1" />
                            )}
                          </button>
                        ))}
                      </div>
                    </motion.div>

                    {/* Continue button */}
                    <motion.div className="flex justify-end pt-2" variants={itemVariants}>
                      <Button
                        onClick={saveProfileAndContinue}
                        className="gap-2 px-6 py-5 text-base rounded-xl"
                        size="lg"
                        disabled={isLoading}
                      >
                        {isLoading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <>
                            {t("common.continue")}
                            <ArrowRight className="h-4 w-4" />
                          </>
                        )}
                      </Button>
                    </motion.div>
                  </>
                )}
              </motion.div>
            )}

            {/* ═══════════════════════════════════════════════ */}
            {/* Step 2: Connect Account                        */}
            {/* ═══════════════════════════════════════════════ */}
            {currentStep === "connect" && (
              <motion.div
                key="connect"
                className="space-y-6"
                variants={containerVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                <motion.div className="text-center mb-4" variants={itemVariants}>
                  <div className="mx-auto bg-brand-primary/10 text-brand-primary h-14 w-14 rounded-full flex items-center justify-center mb-4">
                    <Building2 className="h-7 w-7" />
                  </div>
                  <h2 className="text-2xl font-bold mb-2">
                    {t("onboarding.connect.title")}
                  </h2>
                  <div className="min-h-8">
                    <TypeAnimation
                      sequence={[
                        t("onboarding.connect.subtitle"),
                        () => setConnectAnimDone(true),
                      ]}
                      speed={30}
                      style={{ fontFamily: "Urbanist", display: "inline-block" }}
                      cursor={false}
                    />
                  </div>
                </motion.div>

                {connectAnimDone && (
                  <motion.div className="space-y-3" variants={itemVariants}>
                    {/* Bank sync (#154): Plaid and Enable Banking with equal weight */}
                    <div>
                      <h3 className="font-semibold text-base mb-1">{t("onboarding.connect.bankTitle")}</h3>
                      <p className="text-sm text-muted-foreground mb-3">
                        {t("onboarding.connect.bankDescription")}
                      </p>
                      <BankProviderOptions
                        onPlaidComplete={async () => {
                          completeStep.mutate({ step: "step2_connect", data: { method: "plaid" } });
                          completeStep.mutate({ step: "connectBank" });
                          await finishOnboarding("/");
                        }}
                        onEnableBankingRedirect={recordEnableBankingCompletion}
                      />
                    </div>

                    {/* Divider */}
                    <div className="flex items-center gap-3 py-1">
                      <div className="flex-1 border-t" />
                      <span className="text-xs text-muted-foreground uppercase tracking-wide">
                        {t("common.or")}
                      </span>
                      <div className="flex-1 border-t" />
                    </div>

                    {/* Import sheet option */}
                    <button
                      onClick={() => {
                        setConnectMethod("csv");
                        completeStep.mutate({ step: "step2_connect", data: { method: "csv" } });
                        setCurrentStep("create-account");
                      }}
                      className="flex items-center gap-4 p-4 rounded-xl border hover:bg-accent transition-colors w-full text-left"
                    >
                      <div className="bg-muted h-10 w-10 rounded-full flex items-center justify-center shrink-0">
                        <FileSpreadsheet className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div>
                        <h3 className="font-semibold text-sm">{t("onboarding.connect.importTitle")}</h3>
                        <p className="text-xs text-muted-foreground">
                          {t("onboarding.connect.importDescription")}
                        </p>
                      </div>
                    </button>
                  </motion.div>
                )}
              </motion.div>
            )}

            {/* ═══════════════════════════════════════════════ */}
            {/* Step 3: Select Bank → Create Account            */}
            {/* ═══════════════════════════════════════════════ */}
            {currentStep === "create-account" && (
              <motion.div
                key="create-account"
                className="space-y-4"
                variants={containerVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                {/* Header with back button */}
                <motion.div variants={itemVariants}>
                  <div className="flex items-center gap-3 mb-1">
                    <button
                      onClick={() => setCurrentStep("connect")}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <ArrowLeft className="h-5 w-5" />
                    </button>
                    <div className="bg-brand-primary/10 text-brand-primary h-10 w-10 rounded-full flex items-center justify-center shrink-0">
                      <Wallet className="h-5 w-5" />
                    </div>
                    <div>
                      <h2 className="text-xl font-bold">{t("onboarding.accounts.title")}</h2>
                      <p className="text-sm text-muted-foreground">
                        {t("onboarding.accounts.subtitle")}
                      </p>
                    </div>
                  </div>
                </motion.div>

                <motion.div variants={itemVariants}>
                  <OnboardingAccountSetup
                    selectedCurrencies={preferences.currencies}
                    countryId={primaryCountryId}
                    onComplete={() => finishOnboarding("/agents/import")}
                  />
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </CardContent>
      </Card>
    </div>
  );
}
