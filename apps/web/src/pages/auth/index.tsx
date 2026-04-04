import React, { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useAuth } from "../../contexts/AuthContext";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Loader2 } from "lucide-react";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { setTenantMeta } from "@/utils/tenantMetaStorage";
import { Logo } from "@/components/logo";

/* ══════════════════════════════════════════════════════
   RESPONSIVE HOOK
══════════════════════════════════════════════════════ */

function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(
    () => (typeof window !== "undefined" ? window.innerWidth >= 900 : true)
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 900px)");
    const handler = (e: MediaQueryListEvent) => setDesktop(e.matches);
    mq.addEventListener("change", handler);
    setDesktop(mq.matches);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return desktop;
}

/* ══════════════════════════════════════════════════════
   VALIDATION SCHEMAS
══════════════════════════════════════════════════════ */

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
});

/* ══════════════════════════════════════════════════════
   GOOGLE ICON (multicolor SVG)
══════════════════════════════════════════════════════ */

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
        fill="#34A853"
      />
      <path
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
        fill="#EA4335"
      />
    </svg>
  );
}

/* ══════════════════════════════════════════════════════
   AUTH PILL TABS
══════════════════════════════════════════════════════ */

function AuthTabs({
  activeTab,
  onTabChange,
}: {
  activeTab: string;
  onTabChange: (tab: string) => void;
}) {
  const { t } = useTranslation();
  const tabs = [
    { id: "signin", label: t("Sign In") },
    { id: "signup", label: t("Sign Up") },
  ];

  return (
    <div
      className="flex items-center rounded-[0.875rem] border p-[3px]"
      style={{ background: "hsl(var(--muted))", borderColor: "hsl(var(--border))" }}
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            className="flex-1 text-center font-medium transition-all duration-150 ease-in-out whitespace-nowrap"
            style={{
              padding: "8px 20px",
              borderRadius: "0.6875rem",
              fontSize: "0.875rem",
              background: isActive ? "hsl(var(--brand-deep))" : "transparent",
              color: isActive ? "#FFFFFF" : "hsl(var(--brand-primary))",
              boxShadow: isActive ? "0 1px 4px rgba(58,53,66,0.15)" : "none",
              cursor: "pointer",
              border: "none",
              outline: "none",
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   GOOGLE BUTTON
══════════════════════════════════════════════════════ */

function GoogleButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  const [hov, setHov] = useState(false);

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width: "100%",
        height: 44,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        background: hov ? "hsl(var(--muted))" : "hsl(var(--card))",
        border: "1px solid hsl(var(--border))",
        borderRadius: "0.75rem",
        cursor: "pointer",
        fontSize: "0.9375rem",
        fontWeight: 500,
        color: "hsl(var(--brand-deep))",
        boxShadow: hov
          ? "0 2px 10px rgba(58,53,66,0.09)"
          : "0 1px 3px rgba(58,53,66,0.06)",
        transition: "all 0.14s ease",
        outline: "none",
      }}
    >
      <GoogleIcon />
      {label}
    </button>
  );
}

/* ══════════════════════════════════════════════════════
   OR SEPARATOR
══════════════════════════════════════════════════════ */

function OrSeparator() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 my-5">
      <Separator className="flex-1" />
      <span
        className="text-muted-foreground shrink-0 whitespace-nowrap"
        style={{ fontSize: "0.75rem" }}
      >
        {t("or continue with email")}
      </span>
      <Separator className="flex-1" />
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   SIGN IN FORM
══════════════════════════════════════════════════════ */

function SignInForm({ demoMode = false }: { demoMode?: boolean }) {
  const { t } = useTranslation();
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [isPending, setIsPending] = useState(false);

  const form = useForm({
    resolver: zodResolver(loginSchema),
    defaultValues: demoMode
      ? { email: "daniel@blissfinance.co", password: "bliss1234" }
      : { email: "", password: "" },
  });

  const onSubmit = async (values: z.infer<typeof loginSchema>) => {
    setError("");
    setIsPending(true);
    try {
      await signIn({ email: values.email, password: values.password });
      navigate("/");
    } catch (err: unknown) {
      setError((err as Error).message || t("Login failed"));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-4"
      >
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("Email address")}</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  placeholder="you@example.com"
                  autoComplete="email"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <div className="flex items-center justify-between">
                <FormLabel>{t("Password")}</FormLabel>
                <button
                  type="button"
                  className="text-brand-primary hover:text-primary transition-colors duration-150"
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    fontSize: "0.8125rem",
                    color: "hsl(var(--brand-primary))",
                    borderRadius: 4,
                    transition: "color 0.13s",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.color =
                      "hsl(var(--brand-deep))";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.color =
                      "hsl(var(--brand-primary))";
                  }}
                >
                  {t("Forgot password?")}
                </button>
              </div>
              <FormControl>
                <Input
                  type="password"
                  placeholder="••••••••"
                  autoComplete="current-password"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {error && (
          <div className="text-destructive text-sm">{error}</div>
        )}

        <div className="mt-1">
          <Button type="submit" className="w-full" disabled={isPending}>
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t("Signing in...")}
              </>
            ) : (
              t("Sign In")
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}

/* ══════════════════════════════════════════════════════
   SIGN UP FORM
══════════════════════════════════════════════════════ */

function SignUpForm() {
  const { t } = useTranslation();
  const { signUp } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [isPending, setIsPending] = useState(false);

  const form = useForm({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: "", email: "", password: "" },
  });

  const onSubmit = async (values: z.infer<typeof registerSchema>) => {
    setError("");
    setIsPending(true);
    try {
      const response = await signUp({
        email: values.email,
        password: values.password,
        name: values.name,
        tenantName: values.name,
        countries: [],
        currencies: [],
        bankIds: [],
      });
      const tenantFromResponse =
        response?.user?.tenant || response?.tenant;
      setTenantMeta({
        id: tenantFromResponse?.id || "",
        name: tenantFromResponse?.name || values.name,
        plan: tenantFromResponse?.plan || "FREE",
        createdAt:
          tenantFromResponse?.createdAt || new Date().toISOString(),
        countries: [] as unknown[],
        currencies: [] as unknown[],
        banks: [] as unknown[],
        transactionYears: [] as number[],
        plaidLinkedBankIds: [] as number[] | undefined,
      });
      navigate("/onboarding");
    } catch (err: unknown) {
      setError((err as Error).message || t("Registration failed"));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-4"
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("Full name")}</FormLabel>
              <FormControl>
                <Input
                  type="text"
                  placeholder="Alex Morgan"
                  autoComplete="name"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("Email address")}</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  placeholder="you@example.com"
                  autoComplete="email"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("Password")}</FormLabel>
              <FormControl>
                <Input
                  type="password"
                  placeholder="8+ characters"
                  autoComplete="new-password"
                  {...field}
                />
              </FormControl>
              <FormMessage />
              <p className="text-muted-foreground" style={{ fontSize: "0.75rem", lineHeight: 1.6 }}>
                {t("Use at least 8 characters, including a number.")}
              </p>
            </FormItem>
          )}
        />

        <p
          className="text-muted-foreground"
          style={{ fontSize: "0.75rem", lineHeight: 1.6, margin: 0 }}
        >
          {t("By creating an account you agree to our")}{" "}
          <span
            className="cursor-pointer underline"
            style={{ color: "hsl(var(--brand-primary))" }}
          >
            {t("Terms of Service")}
          </span>{" "}
          {t("and")}{" "}
          <span
            className="cursor-pointer underline"
            style={{ color: "hsl(var(--brand-primary))" }}
          >
            {t("Privacy Policy")}
          </span>
          .
        </p>

        {error && (
          <div className="text-destructive text-sm">{error}</div>
        )}

        <div className="mt-1">
          <Button type="submit" className="w-full" disabled={isPending}>
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t("Creating account...")}
              </>
            ) : (
              t("Create Account")
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}

/* ══════════════════════════════════════════════════════
   AUTH CARD
══════════════════════════════════════════════════════ */

function useDemoMode(): boolean {
  const [isDemo, setIsDemo] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsDemo(params.get("origin") === "docs-site");
  }, []);
  return isDemo;
}

function AuthCard() {
  const { t } = useTranslation();
  const { signInWithGoogle } = useAuth();
  const [tab, setTab] = useState("signin");
  const isDemo = useDemoMode();

  return (
    <Card
      className="w-full border"
      style={{ maxWidth: 420, padding: "28px 32px 32px", gap: 0 }}
    >
      {/* Demo mode banner */}
      {isDemo && (
        <div
          className="text-center rounded-lg"
          style={{
            padding: "10px 16px",
            marginBottom: 16,
            backgroundColor: "hsl(var(--accent))",
            color: "hsl(var(--brand-deep))",
            fontSize: "0.8125rem",
            fontWeight: 500,
            lineHeight: 1.5,
          }}
        >
          {t("Welcome to the Bliss demo. Click Sign In to explore.")}
        </div>
      )}

      {/* Tabs — hidden in demo mode */}
      {!isDemo && (
        <div className="flex justify-center" style={{ marginBottom: 24 }}>
          <AuthTabs activeTab={tab} onTabChange={setTab} />
        </div>
      )}

      {/* Google OAuth — hidden in demo mode */}
      {!isDemo && (
        <>
          <GoogleButton
            label={
              tab === "signin"
                ? t("Sign in with Google")
                : t("Sign up with Google")
            }
            onClick={signInWithGoogle}
          />
          <OrSeparator />
        </>
      )}

      {/* Form — always show signin in demo mode */}
      {(isDemo || tab === "signin") ? <SignInForm demoMode={isDemo} /> : <SignUpForm />}

      {/* Switch prompt — hidden in demo mode */}
      {!isDemo && (
        <p
          className="text-center text-muted-foreground"
          style={{ marginTop: 20, marginBottom: 0, fontSize: "0.8125rem", lineHeight: 1.6 }}
        >
          {tab === "signin" ? (
            <>
              {t("Don't have an account?")}{" "}
              <button
                type="button"
                onClick={() => setTab("signup")}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  color: "hsl(var(--brand-primary))",
                  fontWeight: 500,
                  transition: "color 0.13s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.color =
                    "hsl(var(--brand-deep))";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.color =
                    "hsl(var(--brand-primary))";
                }}
              >
                {t("Create one")}
              </button>
            </>
          ) : (
            <>
              {t("Already have an account?")}{" "}
              <button
                type="button"
                onClick={() => setTab("signin")}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  color: "hsl(var(--brand-primary))",
                  fontWeight: 500,
                  transition: "color 0.13s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.color =
                    "hsl(var(--brand-deep))";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.color =
                    "hsl(var(--brand-primary))";
                }}
              >
                {t("Sign in")}
              </button>
            </>
          )}
        </p>
      )}
    </Card>
  );
}

/* ══════════════════════════════════════════════════════
   LEFT PANEL — brand storytelling + illustration
══════════════════════════════════════════════════════ */

function LeftPanel() {
  const { t } = useTranslation();

  return (
    <div
      className="flex flex-col relative overflow-hidden"
      style={{
        flex: "0 0 50%",
        width: "50%",
        background: "hsl(var(--background))",
      }}
    >
      {/* Subtle ambient glow */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: [
            "radial-gradient(ellipse 65% 50% at 28% 18%, rgba(109,101,122,0.045) 0%, transparent 65%)",
            "radial-gradient(ellipse 50% 40% at 78% 88%, rgba(58,53,66,0.025) 0%, transparent 60%)",
          ].join(", "),
        }}
      />

      {/* Logo */}
      <div className="relative z-10" style={{ padding: "48px 56px 0" }}>
        <Logo size="md" />
      </div>

      {/* Central stack: headline → subheading → illustration */}
      <div
        className="flex-1 flex flex-col items-center justify-center relative z-10"
        style={{ padding: "24px 56px 0" }}
      >
        {/* Taglines */}
        <div className="text-center" style={{ maxWidth: 400, marginBottom: 32 }}>
          <h1
            style={{
              margin: 0,
              fontSize: "clamp(1.9rem, 2.8vw, 2.4rem)",
              fontWeight: 600,
              color: "hsl(var(--brand-deep))",
              letterSpacing: "-0.04em",
              lineHeight: 1.13,
            }}
          >
            {t("The quiet intelligence behind your global wealth.")}
          </h1>
          <p
            style={{
              margin: "16px 0 0",
              fontSize: "1.125rem",
              fontWeight: 400,
              color: "hsl(var(--brand-primary))",
              lineHeight: 1.6,
              letterSpacing: "-0.005em",
            }}
          >
            {t("Financial clarity, without borders.")}
          </p>
        </div>

        {/* Seamless illustration */}
        <div
          className="self-center"
          style={{
            width: "100%",
            maxWidth: 420,
            marginTop: 0,
            background: "transparent",
            lineHeight: 0,
          }}
        >
          <img
            src="/images/auth-mascot.png"
            alt={t(
              "Bliss capybara in a turtleneck, seated in a mid-century chair beside a stack of currency coins"
            )}
            style={{
              width: "100%",
              height: "auto",
              display: "block",
              objectFit: "contain",
              mixBlendMode: "multiply",
            }}
          />
        </div>
      </div>

      {/* Right edge gradient border */}
      <div
        className="absolute top-0 right-0 bottom-0"
        style={{
          width: 1,
          background:
            "linear-gradient(to bottom, transparent 0%, hsl(var(--border)) 20%, hsl(var(--border)) 80%, transparent 100%)",
        }}
      />
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   RIGHT PANEL — auth hub
══════════════════════════════════════════════════════ */

function RightPanel() {
  const { t } = useTranslation();

  return (
    <div
      className="flex flex-col items-center justify-center relative"
      style={{
        flex: "0 0 50%",
        width: "50%",
        background: "rgba(109,101,122,0.05)",
        padding: "32px 40px",
      }}
    >
      {/* Ambient glow */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: [
            "radial-gradient(ellipse 60% 50% at 70% 25%, rgba(229,152,155,0.04) 0%, transparent 65%)",
            "radial-gradient(ellipse 55% 45% at 20% 80%, rgba(58,53,66,0.03) 0%, transparent 60%)",
          ].join(", "),
        }}
      />

      <div
        className="relative z-10 w-full flex flex-col"
        style={{ maxWidth: 420, gap: 28 }}
      >
        <p
          className="text-center text-muted-foreground"
          style={{ margin: 0, fontSize: "0.9375rem", fontWeight: 400 }}
        >
          {t("Welcome back")}
        </p>

        <AuthCard />

        <p
          className="text-center text-muted-foreground"
          style={{ margin: 0, fontSize: "0.75rem", lineHeight: 1.6 }}
        >
          {t("Protected by enterprise-grade encryption.")}{" "}
          <span
            className="cursor-pointer underline"
            style={{ color: "hsl(var(--brand-primary))" }}
          >
            {t("Privacy Policy")}
          </span>
        </p>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   PAGE ROOT
══════════════════════════════════════════════════════ */

export default function AuthPage() {
  const { t } = useTranslation();
  const isDesktop = useIsDesktop();

  /* ── Desktop: 50/50 split ── */
  if (isDesktop) {
    return (
      <div
        className="flex flex-row w-full min-h-screen"
        style={{ background: "hsl(var(--background))" }}
      >
        <LeftPanel />
        <RightPanel />
      </div>
    );
  }

  /* ── Mobile / Tablet: stacked column ── */
  return (
    <div
      className="min-h-screen flex flex-col items-center relative overflow-hidden"
      style={{ background: "hsl(var(--background))" }}
    >
      {/* Ambient */}
      <div
        className="fixed inset-0 pointer-events-none z-0"
        style={{
          backgroundImage:
            "radial-gradient(ellipse 80% 50% at 50% 0%, rgba(109,101,122,0.06) 0%, transparent 65%)",
        }}
      />

      {/* 1. Logo */}
      <div
        className="w-full relative z-10"
        style={{ maxWidth: 480, padding: "36px 24px 0" }}
      >
        <Logo size="sm" />
      </div>

      {/* 2. Headings */}
      <div
        className="w-full text-center relative z-10"
        style={{ maxWidth: 480, padding: "28px 24px 0" }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: "clamp(1.5rem, 5.5vw, 1.875rem)",
            fontWeight: 600,
            color: "hsl(var(--brand-deep))",
            letterSpacing: "-0.035em",
            lineHeight: 1.18,
          }}
        >
          {t("The quiet intelligence behind your global wealth.")}
        </h1>
        <p
          style={{
            margin: "12px 0 0",
            fontSize: "1rem",
            fontWeight: 400,
            color: "hsl(var(--brand-primary))",
            lineHeight: 1.6,
          }}
        >
          {t("Financial clarity, without borders.")}
        </p>
      </div>

      {/* 3. Illustration */}
      <div
        className="w-full relative z-10"
        style={{ maxWidth: 380, padding: "8px 0 0", lineHeight: 0 }}
      >
        <img
          src="/images/auth-mascot.png"
          alt={t("Bliss capybara mascot seated in a mid-century chair")}
          style={{
            width: "100%",
            height: "auto",
            display: "block",
            mixBlendMode: "multiply",
          }}
        />
      </div>

      {/* 4. Auth card */}
      <div
        className="w-full relative z-10"
        style={{ maxWidth: 480, padding: "8px 16px 48px" }}
      >
        <AuthCard />
      </div>

      {/* Footer */}
      <p
        className="text-center text-muted-foreground relative z-10"
        style={{ fontSize: "0.75rem", padding: "0 24px 32px", lineHeight: 1.6 }}
      >
        {t("Protected by enterprise-grade encryption.")}
      </p>
    </div>
  );
}
