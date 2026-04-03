'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useTheme } from 'next-themes';

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <button
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      className="p-2 rounded-lg hover:opacity-80 transition-opacity"
      style={{ color: 'hsl(var(--foreground))' }}
      aria-label="Toggle theme"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" />
        <line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" />
        <line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>
    </button>
  );
}

const FEATURES = [
  {
    title: 'Expense Tracking',
    description: 'AI-classified transactions with category breakdowns, monthly trends, and top expense analysis across all currencies.',
    screenshot: '/images/expenses.png',
    link: '/docs/specs/analytics',
  },
  {
    title: 'Portfolio Holdings',
    description: 'FIFO lot tracking with historical FX rates, real-time pricing, and asset allocation across stocks, ETFs, crypto, and real estate.',
    screenshot: '/images/portfolio.png',
    link: '/docs/specs/portfolio',
  },
  {
    title: 'Smart Import',
    description: 'CSV/XLSX ingestion with adapter detection, SHA-256 deduplication, 4-tier AI classification, and staged review before commit.',
    screenshot: '/images/smartimport.png',
    link: '/docs/specs/smart-import',
  },
  {
    title: 'AI Insights',
    description: '7 financial lenses analyze your data daily: spending velocity, income stability, savings rate, portfolio concentration, and more.',
    screenshot: '/images/insights.png',
    link: '/docs/specs/ai-insights',
  },
  {
    title: 'Account Management',
    description: 'Master-detail accounts with Plaid connection health, sync logs, token rotation, and multi-bank support across 10+ countries.',
    screenshot: '/images/accountspagewithplaid.png',
    link: '/docs/specs/account-management',
  },
  {
    title: 'Transaction Review',
    description: 'Deep-dive drawer with AI analysis, investment enrichment, merchant history, and one-click category corrections that train the model.',
    screenshot: '/images/transactionreviewdrawer.png',
    link: '/docs/specs/ai-classification-and-review',
  },
];

const TECH_STACK = [
  'Next.js 15 API (Pages Router, ESM)',
  'Express + BullMQ Backend (CJS)',
  'React 18 + Vite SPA (shadcn/ui)',
  'PostgreSQL 16 with pgvector',
  'Redis 7 (BullMQ queues)',
  'Prisma 6 ORM + AES-256-GCM encryption',
];

export default function HomePage() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div
      className="min-h-screen"
      style={{
        backgroundColor: 'hsl(var(--background))',
        color: 'hsl(var(--foreground))',
      }}
    >
      {/* ── Navbar ─────────────────────────────────────────── */}
      <nav
        className="sticky top-0 z-50"
        style={{
          backgroundColor: 'hsl(var(--background) / 0.85)',
          backdropFilter: 'blur(12px) saturate(1.5)',
          borderBottom: '1px solid hsl(var(--border))',
        }}
      >
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link
            href="/"
            className="font-semibold text-lg tracking-tight"
            style={{ color: 'hsl(var(--brand-deep))' }}
          >
            Bliss<span style={{ color: 'hsl(var(--brand-primary))' }}>Finance</span>
          </Link>

          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-6">
            <Link
              href="/docs"
              className="text-sm font-medium hover:opacity-80 transition-opacity"
              style={{ color: 'hsl(var(--foreground))' }}
            >
              Documentation
            </Link>
            <Link
              href="/docs/api-reference"
              className="text-sm font-medium hover:opacity-80 transition-opacity"
              style={{ color: 'hsl(var(--foreground))' }}
            >
              API Reference
            </Link>
            <a
              href="https://github.com/danielviana/bliss"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium hover:opacity-80 transition-opacity"
              style={{ color: 'hsl(var(--foreground))' }}
            >
              GitHub
            </a>
            <ThemeToggle />
          </div>

          {/* Mobile hamburger */}
          <div className="flex md:hidden items-center gap-2">
            <ThemeToggle />
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="p-2"
              style={{ color: 'hsl(var(--foreground))' }}
              aria-label="Toggle menu"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                {mobileMenuOpen ? (
                  <path d="M18 6L6 18M6 6l12 12" />
                ) : (
                  <path d="M3 12h18M3 6h18M3 18h18" />
                )}
              </svg>
            </button>
          </div>
        </div>

        {/* Mobile dropdown */}
        {mobileMenuOpen && (
          <div
            className="md:hidden px-6 pb-4 flex flex-col gap-3"
            style={{ borderBottom: '1px solid hsl(var(--border))' }}
          >
            <Link href="/docs" className="text-sm font-medium py-1" style={{ color: 'hsl(var(--foreground))' }}>
              Documentation
            </Link>
            <Link href="/docs/api-reference" className="text-sm font-medium py-1" style={{ color: 'hsl(var(--foreground))' }}>
              API Reference
            </Link>
            <a
              href="https://github.com/danielviana/bliss"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium py-1"
              style={{ color: 'hsl(var(--foreground))' }}
            >
              GitHub
            </a>
          </div>
        )}
      </nav>

      {/* ── Hero ───────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div className="max-w-6xl mx-auto px-6 pt-20 pb-16 md:pt-28 md:pb-24">
          <div className="flex flex-col md:flex-row items-center gap-10 md:gap-16">
            {/* Left: text */}
            <div className="flex-1 text-center md:text-left">
              <div
                className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium mb-6"
                style={{
                  backgroundColor: 'hsl(var(--accent))',
                  color: 'hsl(var(--brand-primary))',
                }}
              >
                Open Source
              </div>
              <h1
                className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight leading-tight"
                style={{ color: 'hsl(var(--brand-deep))' }}
              >
                Open-Source Wealth Management{' '}
                <span style={{ color: 'hsl(var(--brand-primary))' }}>for a Multi-Currency World</span>
              </h1>
              <p
                className="mt-6 text-lg md:text-xl leading-relaxed max-w-2xl"
                style={{ color: 'hsl(var(--muted-foreground))' }}
              >
                AI-powered transaction classification, real-time portfolio tracking, and event-driven analytics.
                Built for self-hosting. Designed for global finances.
              </p>
              <div className="mt-10 flex flex-wrap gap-4 justify-center md:justify-start">
                <Link
                  href="/docs/getting-started"
                  className="inline-flex items-center px-7 py-3.5 rounded-xl font-semibold text-sm transition-all hover:opacity-90"
                  style={{
                    backgroundColor: 'hsl(var(--brand-deep))',
                    color: 'hsl(var(--primary-foreground))',
                  }}
                >
                  Get Started
                </Link>
                <Link
                  href="/docs"
                  className="inline-flex items-center px-7 py-3.5 rounded-xl font-semibold text-sm transition-all hover:opacity-80"
                  style={{
                    border: '1px solid hsl(var(--border))',
                    color: 'hsl(var(--foreground))',
                  }}
                >
                  Explore Docs
                </Link>
              </div>
            </div>

            {/* Right: mascot */}
            <div className="flex-shrink-0 w-64 md:w-80">
              <Image
                src="/images/auth-mascot.png"
                alt="Bliss capybara mascot in a turtleneck, seated in a mid-century chair beside currency coins"
                width={400}
                height={400}
                className="w-full h-auto"
                priority
              />
            </div>
          </div>
        </div>

        {/* Background gradient decoration */}
        <div
          className="absolute -top-40 -right-40 w-96 h-96 rounded-full opacity-20 blur-3xl pointer-events-none"
          style={{ backgroundColor: 'hsl(var(--brand-primary))' }}
        />
      </section>

      {/* ── Features with Screenshots ─────────────────────── */}
      <section
        className="py-16 md:py-20"
        style={{ borderTop: '1px solid hsl(var(--border))' }}
      >
        <div className="max-w-6xl mx-auto px-6">
          <h2
            className="text-2xl md:text-3xl font-bold tracking-tight mb-4"
            style={{ color: 'hsl(var(--brand-deep))' }}
          >
            Built for Serious Finance Tracking
          </h2>
          <p className="text-base mb-12 max-w-2xl" style={{ color: 'hsl(var(--muted-foreground))' }}>
            Every feature is production-grade, multi-currency aware, and designed to learn from your data.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {FEATURES.map((feature) => (
              <Link
                key={feature.title}
                href={feature.link}
                className="glass-card overflow-hidden group hover:shadow-lg transition-shadow"
              >
                <div className="aspect-video overflow-hidden" style={{ backgroundColor: 'hsl(var(--muted))' }}>
                  <Image
                    src={feature.screenshot}
                    alt={feature.title}
                    width={600}
                    height={340}
                    className="w-full h-full object-cover object-top group-hover:scale-[1.02] transition-transform duration-300"
                  />
                </div>
                <div className="p-5">
                  <h3
                    className="text-base font-semibold mb-2"
                    style={{ color: 'hsl(var(--brand-deep))' }}
                  >
                    {feature.title}
                  </h3>
                  <p className="text-sm leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {feature.description}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ── Architecture at a Glance ───────────────────────── */}
      <section
        className="py-16 md:py-20"
        style={{ borderTop: '1px solid hsl(var(--border))' }}
      >
        <div className="max-w-6xl mx-auto px-6">
          <h2
            className="text-2xl md:text-3xl font-bold tracking-tight mb-4"
            style={{ color: 'hsl(var(--brand-deep))' }}
          >
            Architecture at a Glance
          </h2>
          <p className="text-base mb-10 max-w-2xl" style={{ color: 'hsl(var(--muted-foreground))' }}>
            Three services behind a single .env file. Browser talks to the API, API delegates heavy work to the backend via BullMQ.
          </p>
          <div className="glass-card p-6 md:p-8 overflow-x-auto">
            <pre
              className="text-sm leading-relaxed font-mono"
              style={{ color: 'hsl(var(--foreground))' }}
            >
{`Browser (React 18 + Vite)
  │
  └─► Nginx (:8080)
        ├─► Next.js API (:3000)     Auth, REST, Prisma ORM
        └─► Express Backend (:3001)  BullMQ workers, AI pipelines
              │
              ├─► PostgreSQL 16 (pgvector)
              └─► Redis 7 (queues + cache)`}
            </pre>
          </div>
        </div>
      </section>

      {/* ── Tech Stack ─────────────────────────────────────── */}
      <section
        className="py-16 md:py-20"
        style={{ borderTop: '1px solid hsl(var(--border))' }}
      >
        <div className="max-w-6xl mx-auto px-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
            <div>
              <h2
                className="text-2xl md:text-3xl font-bold tracking-tight mb-6"
                style={{ color: 'hsl(var(--brand-deep))' }}
              >
                Tech Stack
              </h2>
              <ul className="space-y-3">
                {TECH_STACK.map((item) => (
                  <li key={item} className="flex items-start gap-3 text-sm" style={{ color: 'hsl(var(--foreground))' }}>
                    <span
                      className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: 'hsl(var(--brand-primary))' }}
                    />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h2
                className="text-2xl md:text-3xl font-bold tracking-tight mb-6"
                style={{ color: 'hsl(var(--brand-deep))' }}
              >
                10 BullMQ Workers
              </h2>
              <p className="text-sm leading-relaxed mb-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
                Every heavy operation runs asynchronously. Classification, portfolio valuation,
                analytics, insights, Plaid sync, and security master refresh — all processed
                via dedicated workers with structured error reporting.
              </p>
              <Link
                href="/docs/architecture"
                className="inline-flex items-center gap-1 text-sm font-medium hover:opacity-80 transition-opacity"
                style={{ color: 'hsl(var(--brand-primary))' }}
              >
                Read the architecture guide
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ─────────────────────────────────────────── */}
      <footer
        className="py-10"
        style={{ borderTop: '1px solid hsl(var(--border))' }}
      >
        <div className="max-w-6xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4">
          <span className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
            {new Date().getFullYear()} Bliss Finance. Open-source under MIT License.
          </span>
          <div className="flex items-center gap-6">
            <Link
              href="/docs"
              className="text-sm hover:opacity-80 transition-opacity"
              style={{ color: 'hsl(var(--muted-foreground))' }}
            >
              Docs
            </Link>
            <a
              href="https://github.com/danielviana/bliss"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm hover:opacity-80 transition-opacity"
              style={{ color: 'hsl(var(--muted-foreground))' }}
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
