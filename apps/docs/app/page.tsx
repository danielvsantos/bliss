'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';

/* ── GitHub icon ─────────────────────────────────────────── */
const GitHubIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} fill="currentColor" viewBox="0 0 24 24">
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
  </svg>
);

/* ── Arrow icon ──────────────────────────────────────────── */
const ArrowRight = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M5 12h14M12 5l7 7-7 7" />
  </svg>
);

export default function HomePage() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="min-h-screen bg-[#FAFAFA]">
      {/* ── Navbar ─────────────────────────────────────────── */}
      <nav
        className="sticky top-0 z-50"
        style={{
          backgroundColor: 'rgba(250,250,250,0.85)',
          backdropFilter: 'blur(12px) saturate(1.5)',
          borderBottom: '1px solid #E2E8F0',
        }}
      >
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link
            href="/"
            style={{
              fontFamily: "'Urbanist', sans-serif",
              fontSize: '1.25rem',
              fontWeight: 600,
              letterSpacing: '-0.03em',
              color: '#6D657A',
              lineHeight: 1,
              userSelect: 'none',
              textDecoration: 'none',
            }}
          >
            bliss
          </Link>

          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-5">
            <Link href="/docs" className="text-sm font-medium transition-colors hover:text-[#6D657A]" style={{ color: '#3A3542' }}>
              Documentation
            </Link>
            <Link href="/docs/api-reference" className="text-sm font-medium transition-colors hover:text-[#6D657A]" style={{ color: '#3A3542' }}>
              API Reference
            </Link>
            <a
              href="https://app.blissfinance.co/auth?origin=docs-site"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:bg-[#2A2631]"
              style={{ backgroundColor: '#3A3542', color: '#fff' }}
            >
              Live Demo
            </a>
            <a
              href="https://github.com/danielvsantos/bliss"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-[#6D657A]"
              style={{ color: '#3A3542' }}
              aria-label="GitHub"
            >
              <GitHubIcon />
            </a>
          </div>

          {/* Mobile hamburger */}
          <button
            className="md:hidden p-2"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            style={{ color: '#3A3542' }}
            aria-label="Toggle menu"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {mobileMenuOpen ? <path d="M18 6L6 18M6 6l12 12" /> : <path d="M3 12h18M3 6h18M3 18h18" />}
            </svg>
          </button>
        </div>

        {mobileMenuOpen && (
          <div className="md:hidden px-6 pb-4 flex flex-col gap-3" style={{ borderBottom: '1px solid #E2E8F0' }}>
            <Link href="/docs" className="text-sm font-medium py-1" style={{ color: '#3A3542' }}>Documentation</Link>
            <Link href="/docs/api-reference" className="text-sm font-medium py-1" style={{ color: '#3A3542' }}>API Reference</Link>
            <a href="https://app.blissfinance.co/auth?origin=docs-site" target="_blank" rel="noopener noreferrer" className="text-sm font-medium py-1" style={{ color: '#6D657A' }}>Live Demo</a>
            <a href="https://github.com/danielvsantos/bliss" target="_blank" rel="noopener noreferrer" className="text-sm font-medium py-1" style={{ color: '#3A3542' }}>GitHub</a>
          </div>
        )}
      </nav>

      {/* ━━ SECTION 1: Hero ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <section className="relative overflow-hidden">
        <div className="max-w-6xl mx-auto px-6 pt-20 pb-16 md:pt-28 md:pb-24">
          <div className="flex flex-col md:flex-row items-center gap-10 md:gap-16">
            <div className="flex-1 text-center md:text-left space-y-6">
              <div
                className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium"
                style={{ backgroundColor: 'hsl(var(--accent))', color: '#6D657A' }}
              >
                Open Source
              </div>
              <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight leading-tight" style={{ color: '#3A3542' }}>
                Self-Hosted Personal Finance{' '}
                <span style={{ color: '#6D657A' }}>for Global Citizens</span>
              </h1>
              <p className="text-lg md:text-xl leading-relaxed max-w-2xl" style={{ color: '#5A5266' }}>
                AI-powered transaction classification, real-time portfolio tracking, and event-driven analytics.
                Secured by AES-256 encryption. Built for self-hosting. Designed for global finances.
              </p>

              {/* CTAs — stack vertically on mobile */}
              <div className="flex flex-col sm:flex-row gap-4 justify-center md:justify-start">
                <Link
                  href="/docs/guides/docker-quickstart"
                  className="inline-flex items-center justify-center px-7 py-3.5 rounded-xl font-semibold text-sm transition-colors hover:bg-[#2A2631]"
                  style={{ backgroundColor: '#3A3542', color: '#fff' }}
                >
                  Get Started
                </Link>
                <a
                  href="https://github.com/danielvsantos/bliss"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl font-semibold text-sm transition-colors hover:bg-gray-50"
                  style={{ border: '1px solid #E2E8F0', color: '#3A3542' }}
                >
                  <GitHubIcon size={16} />
                  GitHub
                </a>
                <a
                  href="https://app.blissfinance.co/auth?origin=docs-site"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center px-7 py-3.5 rounded-xl font-semibold text-sm transition-colors hover:bg-gray-50"
                  style={{ border: '1px solid #E2E8F0', color: '#5A5266' }}
                >
                  Live Demo
                </a>
              </div>

            </div>

            {/* Mascot */}
            <div className="flex-shrink-0 w-64 md:w-72">
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
          style={{ backgroundColor: '#6D657A' }}
        />
      </section>

      {/* ━━ SECTION 2: Architectural Reveal ━━━━━━━━━━━━━━━━ */}
      <section className="py-16 md:py-24" style={{ borderTop: '1px solid #E2E8F0' }}>
        <div className="max-w-6xl mx-auto px-6">
          <p className="text-[11px] sm:text-xs font-semibold tracking-[0.2em] uppercase mb-3" style={{ color: '#6D657A' }}>
            Production-Grade Infrastructure
          </p>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight mb-4" style={{ color: '#3A3542' }}>
            Three services. Ten workers. Sixty endpoints. One configuration file.
          </h2>
          <p className="text-sm leading-relaxed mb-10 max-w-2xl" style={{ color: '#5A5266' }}>
            A monorepo architecture designed for privacy-first self-hosting.
          </p>

          {/* Desktop: SVG architecture diagram — transparent background */}
          <div className="hidden lg:block glass-card p-3 overflow-hidden" style={{ backgroundColor: 'transparent' }}>
            <div className="mx-auto" style={{ maxWidth: 1200 }}>
              <Image
                src="/images/blissarchitecture.svg"
                alt="Bliss Finance architecture: Nginx entrypoint routing to React SPA, Next.js API, and Express backend with 10 BullMQ workers, PostgreSQL with pgvector, Redis, and third-party integrations"
                width={1200}
                height={700}
                className="w-full h-auto"
              />
            </div>
          </div>

          {/* Link to full architecture docs */}
          <div className="hidden lg:block mt-6">
            <Link
              href="/docs/architecture"
              className="inline-flex items-center gap-1 text-sm font-medium transition-colors hover:text-[#3A3542]"
              style={{ color: '#6D657A' }}
            >
              Explore the full architecture <ArrowRight />
            </Link>
          </div>

          {/* Mobile: Terminal-style ASCII tree */}
          <div className="block lg:hidden">
            <div className="rounded-xl overflow-hidden" style={{ backgroundColor: '#1E1E1E' }}>
              {/* macOS dots */}
              <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: '1px solid #333' }}>
                <span className="w-3 h-3 rounded-full" style={{ backgroundColor: '#FF5F56' }} />
                <span className="w-3 h-3 rounded-full" style={{ backgroundColor: '#FFBD2E' }} />
                <span className="w-3 h-3 rounded-full" style={{ backgroundColor: '#27C93F' }} />
                <span className="ml-3 text-xs" style={{ color: '#888' }}>architecture.sh</span>
              </div>
              <div className="p-5 overflow-x-auto">
                <pre className="text-xs leading-relaxed font-mono" style={{ color: '#D4D4D4' }}>
{`[ ENTRYPOINT: Nginx :8080 (Docker) ]
│
├──► /     [ FRONTEND SPA ]
│           ├── React 18, Vite 6, shadcn/ui
│           └── Communicates via REST (JWT in HttpOnly Cookie)
│
├──► /api/ [ API LAYER ]
│           ├── Next.js 15 (Pages Router), NextAuth
│           ├── >60 Endpoints (Transactions, Reports, Users)
│           └── Communicates via Internal REST (API Key Auth)
│
└──► /svc/ [ EXPRESS BACKEND :3001 ]
            ├── Event-Driven Architecture
            ├── 10 Asynchronous BullMQ Workers
            │
            ├─► Redis 7 (Cache + Job Queues)
            │
            ├─► Database: PostgreSQL 16 + pgvector
            │   ├── Secure Store: AES-256-GCM Encryption
            │   └── AI Embeddings: 768-dim Vectors
            │
            └─► 3rd Party Integrations:
                ├─► AI: Gemini LLM (Classification)
                ├─► Banks: Plaid (Sync + Tokens)
                ├─► Prices: TwelveData (Real-time Stocks)
                ├─► FX: CurrencyLayer (Historical Rates)
                └─► Ops: Sentry (Observability)`}
                </pre>
              </div>
            </div>
            <div className="mt-6">
              <Link
                href="/docs/architecture"
                className="inline-flex items-center gap-1 text-sm font-medium transition-colors hover:text-[#3A3542]"
                style={{ color: '#6D657A' }}
              >
                Explore the full architecture <ArrowRight />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ━━ SECTION 3: Global Ledger (The Prize — Outcome first) ━━━ */}
      <section className="py-16 md:py-24" style={{ borderTop: '1px solid #E2E8F0' }}>
        <div className="max-w-6xl mx-auto px-6">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight mb-3" style={{ color: '#3A3542' }}>
            Multi-Currency Wealth, Unified.
          </h2>
          <p className="text-base leading-relaxed mb-12 max-w-3xl" style={{ color: '#5A5266' }}>
            Built from the ground up for cross-border portfolios. Backend asynchronous workers calculate
            historical exchange rates, ensuring your frontend dashboard never has to perform currency math on the fly.
          </p>

          <div className="flex flex-col lg:flex-row gap-10 items-center">
            {/* Left: Two-image overlap */}
            <div className="flex-1 w-full">
              {/* Desktop: portfolio front, expenses behind-right */}
              <div className="hidden md:block relative w-full" style={{ height: '440px' }}>
                {/* Back — Expenses (offset right and down, slight rotation) */}
                <div
                  className="absolute rounded-xl overflow-hidden transition-transform duration-300"
                  style={{
                    width: '78%',
                    top: '8%',
                    right: 0,
                    transform: 'rotate(2deg)',
                    boxShadow: '0 8px 30px rgba(0,0,0,0.08)',
                    border: '1px solid #E2E8F0',
                    zIndex: 10,
                  }}
                >
                  <Image src="/images/expenses.png" alt="Expense tracking with category breakdown and monthly totals" width={700} height={500} className="w-full h-auto" />
                </div>
                {/* Front — Portfolio (anchored left, no rotation, stronger shadow) */}
                <div
                  className="absolute rounded-xl overflow-hidden transition-transform duration-300"
                  style={{
                    width: '78%',
                    top: '4%',
                    left: 0,
                    boxShadow: '0 25px 60px -15px rgba(0,0,0,0.18)',
                    border: '1px solid #E2E8F0',
                    zIndex: 20,
                  }}
                >
                  <Image src="/images/portfolio.png" alt="Portfolio holdings with area chart showing net worth growth across stocks, ETFs, bonds, and private equity" width={700} height={500} className="w-full h-auto" />
                </div>
              </div>

              {/* Mobile: simple stack */}
              <div className="md:hidden space-y-4">
                <div className="glass-card overflow-hidden">
                  <Image src="/images/portfolio.png" alt="Portfolio holdings dashboard" width={600} height={400} className="w-full h-auto" />
                </div>
                <div className="glass-card overflow-hidden">
                  <Image src="/images/expenses.png" alt="Expense tracking" width={600} height={400} className="w-full h-auto" />
                </div>
              </div>
            </div>

            {/* Right: Features */}
            <div className="flex-1 lg:max-w-sm">
              <div className="space-y-8">
                <div>
                  <h3 className="text-base font-semibold mb-2" style={{ color: '#3A3542' }}>
                    The Unified P&L Engine
                  </h3>
                  <p className="text-sm leading-relaxed" style={{ color: '#5A5266' }}>
                    Automatically normalizes income and expenses across borders using historical FX rates
                    to give you a single base-currency view of your entire financial life.
                  </p>
                </div>

                <div>
                  <h3 className="text-base font-semibold mb-2" style={{ color: '#3A3542' }}>
                    Real-Time Portfolio Tracking
                  </h3>
                  <p className="text-sm leading-relaxed" style={{ color: '#5A5266' }}>
                    Asynchronous workers track FIFO lots and integrate directly with the Twelve Data API
                    for live stock/ETF prices. Historical cost-basis calculations happen in the background,
                    never blocking your dashboard.
                  </p>
                </div>

                <div>
                  <h3 className="text-base font-semibold mb-2" style={{ color: '#3A3542' }}>
                    Event-Driven Analytics
                  </h3>
                  <p className="text-sm leading-relaxed" style={{ color: '#5A5266' }}>
                    Every transaction triggers a scoped analytics update. Monthly aggregations across categories,
                    tags, currencies, and countries are computed incrementally — never a full table scan.
                  </p>
                </div>

                <Link
                  href="/docs/specifications"
                  className="inline-flex items-center gap-1 text-sm font-medium transition-colors hover:text-[#3A3542]"
                  style={{ color: '#6D657A' }}
                >
                  View specifications <ArrowRight />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ━━ SECTION 4: Intelligence Pipeline (The Magic — Mechanism second) ━━━ */}
      <section className="py-16 md:py-24" style={{ borderTop: '1px solid #E2E8F0' }}>
        <div className="max-w-6xl mx-auto px-6">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight mb-3" style={{ color: '#3A3542' }}>
            Eradicate Manual Data Entry
          </h2>
          <p className="text-base leading-relaxed mb-12 max-w-3xl" style={{ color: '#5A5266' }}>
            A multi-tier classification waterfall deterministically routes and categorizes your
            transactions without relying entirely on expensive LLM calls.
          </p>

          {/* Grid with stretch so bottom edges align */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-stretch">
            {/* Box 1: Classification Engine (large, left, spans 2 rows) */}
            <div className="glass-card overflow-hidden md:row-span-2 flex flex-col">
              <div className="p-6 pb-4">
                <h3 className="text-lg font-semibold mb-3" style={{ color: '#3A3542' }}>
                  4-Tier Classification Engine
                </h3>
                <p className="text-sm leading-relaxed" style={{ color: '#5A5266' }}>
                  A deterministic AI waterfall eradicates manual entry. Transactions cascade through an
                  exact-match Redis cache, a pgvector similarity search, and a Gemini LLM fallback. User
                  corrections automatically generate new vector embeddings, creating a reinforcement learning loop.
                </p>
                <Link
                  href="/docs/guides/ai-classification"
                  className="inline-flex items-center gap-1 text-xs font-medium mt-3 transition-colors hover:text-[#3A3542]"
                  style={{ color: '#6D657A' }}
                >
                  Read the classification guide <ArrowRight />
                </Link>
              </div>
              {/* Screenshot — full image visible, vertically centered, constrained width on desktop */}
              <div className="flex-1 px-6 pb-6 flex items-center justify-center">
                <div className="w-full md:max-w-[400px] rounded-lg overflow-hidden" style={{ border: '1px solid #E2E8F0', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
                  <Image
                    src="/images/classification.png"
                    alt="Transaction review showing AI classification with confidence scoring"
                    width={400}
                    height={300}
                    className="w-full h-auto"
                  />
                </div>
              </div>
            </div>

            {/* Box 2: Secure Institution Sync (small, top right) */}
            <div className="glass-card p-6 flex flex-col">
              <div className="flex items-center gap-3 mb-4">
                <Image
                  src="/images/plaidlogo.png"
                  alt="Plaid"
                  width={28}
                  height={28}
                  className="w-7 h-7"
                />
                <h3 className="text-lg font-semibold" style={{ color: '#3A3542' }}>
                  Secure Institution Sync
                </h3>
              </div>
              <p className="text-sm leading-relaxed mb-4" style={{ color: '#5A5266' }}>
                Robust Plaid webhook ingestion handles encrypted payload staging, optimistic account linking,
                and automated token rotation.
              </p>
              <Link
                href="/docs/guides/plaid-bank-sync"
                className="inline-flex items-center gap-1 text-xs font-medium mb-4 transition-colors hover:text-[#3A3542]"
                style={{ color: '#6D657A' }}
              >
                Plaid setup guide <ArrowRight />
              </Link>
              {/* Icon lockup: Plaid → arrow → Bliss */}
              <div className="mt-auto flex items-center justify-center gap-6 py-6" style={{ backgroundColor: 'hsl(var(--muted))', borderRadius: '12px' }}>
                <div className="flex flex-col items-center gap-2">
                  <div className="w-14 h-14 rounded-2xl bg-white flex items-center justify-center" style={{ border: '1px solid #E2E8F0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                    <Image src="/images/plaidlogo.png" alt="Plaid" width={24} height={24} className="w-6 h-6" />
                  </div>
                  <span className="text-[10px] font-medium" style={{ color: '#5A5266' }}>Plaid</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <svg width="32" height="16" viewBox="0 0 32 16" fill="none">
                    <path d="M0 8h28M24 3l4 5-4 5" stroke="#6D657A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="text-[9px] font-medium" style={{ color: '#5A5266' }}>AES-256</span>
                </div>
                <div className="flex flex-col items-center gap-2">
                  <div className="w-14 h-14 rounded-2xl bg-white flex items-center justify-center" style={{ border: '1px solid #E2E8F0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                    <span style={{ fontFamily: "'Urbanist', sans-serif", fontSize: '0.875rem', fontWeight: 600, color: '#6D657A', letterSpacing: '-0.03em' }}>bliss</span>
                  </div>
                  <span className="text-[10px] font-medium" style={{ color: '#5A5266' }}>Bliss</span>
                </div>
              </div>
            </div>

            {/* Box 3: Extensible File Ingestion — bleeding edge image */}
            <div className="glass-card overflow-hidden flex flex-col">
              <div className="p-6 pb-4">
                <div className="flex items-center gap-3 mb-4">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3A3542" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                    <polyline points="10 9 9 9 8 9" />
                  </svg>
                  <h3 className="text-lg font-semibold" style={{ color: '#3A3542' }}>
                    Extensible File Ingestion
                  </h3>
                </div>
                <p className="text-sm leading-relaxed" style={{ color: '#5A5266' }}>
                  A streaming engine detects CSV/XLSX schemas and executes SHA-256 row deduplication.
                  Easily write custom TypeScript adapters to ingest data from unsupported regional banks or legacy systems.
                </p>
                <Link
                  href="/docs/guides/importing-transactions"
                  className="inline-flex items-center gap-1 text-xs font-medium mt-3 transition-colors hover:text-[#3A3542]"
                  style={{ color: '#6D657A' }}
                >
                  Import guide <ArrowRight />
                </Link>
              </div>
              {/* Bleeding-edge screenshot — offset right, clipped at card edge */}
              <div className="mt-auto overflow-hidden" style={{ marginRight: '-16px', marginBottom: '-1px' }}>
                <Image
                  src="/images/smartimportadapter.png"
                  alt="Smart Import adapter creation modal showing column mapping configuration"
                  width={500}
                  height={350}
                  className="w-full h-auto rounded-tl-lg"
                  style={{ marginLeft: '16px', boxShadow: '0 -4px 20px rgba(0,0,0,0.06)' }}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ━━ SECTION 5: Production-Grade Infrastructure ━━━━━ */}
      <section className="py-16 md:py-24" style={{ borderTop: '1px solid #E2E8F0' }}>
        <div className="max-w-6xl mx-auto px-6">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-3" style={{ color: '#3A3542' }}>
            Built for the Homelab. Enterprise-Grade Architecture.
          </h2>
          <p className="text-base leading-relaxed mb-12 max-w-3xl" style={{ color: '#5A5266' }}>
            A decoupled architecture ensuring absolute privacy, rock-solid stability, and the ability
            to host multiple users from a single deployment.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Column 1: Multi-Tenant — circular icon wrapper */}
            <div className="glass-card p-6">
              <div className="w-16 h-16 rounded-full flex items-center justify-center mb-5" style={{ backgroundColor: 'hsl(var(--muted))' }}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#6D657A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <h3 className="text-base font-semibold mb-2" style={{ color: '#3A3542' }}>
                Multi-Tenant, Multi-User
              </h3>
              <p className="text-sm leading-relaxed mb-3" style={{ color: '#5A5266' }}>
                Host completely isolated financial environments for family, friends, or a partner from a
                single deployment. Strict query-level tenant isolation with view-only access for shared visibility.
              </p>
              <div className="flex flex-wrap gap-3">
                <Link
                  href="/docs/guides/multi-tenant-deployment"
                  className="inline-flex items-center gap-1 text-xs font-medium transition-colors hover:text-[#3A3542]"
                  style={{ color: '#6D657A' }}
                >
                  Deployment guide <ArrowRight />
                </Link>
                <a
                  href="https://app.blissfinance.co/auth?origin=docs-site"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium transition-colors hover:text-[#3A3542]"
                  style={{ color: '#6D657A' }}
                >
                  Try the live demo <ArrowRight />
                </a>
              </div>
            </div>

            {/* Column 2: Encryption — circular icon wrapper */}
            <div className="glass-card p-6">
              <div className="w-16 h-16 rounded-full flex items-center justify-center mb-5" style={{ backgroundColor: 'hsl(var(--muted))' }}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#6D657A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </div>
              <h3 className="text-base font-semibold mb-2" style={{ color: '#3A3542' }}>
                AES-256-GCM Encryption
              </h3>
              <p className="text-sm leading-relaxed" style={{ color: '#5A5266' }}>
                Your sensitive data — including Plaid access tokens and raw bank payloads — is encrypted
                at rest, ensuring your financial footprint remains strictly yours.
              </p>
            </div>

            {/* Column 3: Reliability — CI image as cover photo */}
            <div className="glass-card overflow-hidden flex flex-col">
              <div className="overflow-hidden" style={{ backgroundColor: '#F6F8FA' }}>
                <Image
                  src="/images/cipaths.png"
                  alt="CI pipeline showing 1,076 passing tests across 152 test files"
                  width={400}
                  height={200}
                  className="w-full h-auto"
                />
              </div>
              <div className="p-6">
                <h3 className="text-base font-semibold mb-2" style={{ color: '#3A3542' }}>
                  Bulletproof Reliability
                </h3>
                <p className="text-sm leading-relaxed" style={{ color: '#5A5266' }}>
                  Orchestrated by 10 independent BullMQ workers and protected by over 1,000 automated CI pipeline tests.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ━━ SECTION 6: AI-Ready Codebase ━━━━━━━━━━━━━━━━━━━ */}
      <section className="py-16 md:py-24" style={{ borderTop: '1px solid #E2E8F0' }}>
        <div className="max-w-6xl mx-auto px-6">
          <p className="text-[11px] sm:text-xs font-semibold tracking-[0.2em] uppercase mb-3" style={{ color: '#6D657A' }}>
            Developer Experience
          </p>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight mb-3" style={{ color: '#3A3542' }}>
            Engineered for AI Coding Agents.
          </h2>
          <p className="text-base leading-relaxed mb-12 max-w-3xl" style={{ color: '#5A5266' }}>
            Bliss is built with strict Spec-Driven Development. Every repository includes embedded context files,
            allowing tools like Claude Code or GitHub Copilot to onboard instantly and start shipping features safely.
          </p>

          <div className="flex flex-col lg:flex-row gap-10 items-start">
            {/* Left: Bullets */}
            <div className="flex-1 space-y-6">
              <div className="flex gap-4">
                <div className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center mt-0.5" style={{ backgroundColor: 'hsl(var(--muted))' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6D657A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-base font-semibold mb-1" style={{ color: '#3A3542' }}>CLAUDE.md Primed</h3>
                  <p className="text-sm leading-relaxed" style={{ color: '#5A5266' }}>
                    Five layered context files detailing architecture, module systems, testing rules, and
                    state management conventions. AI agents load the right context automatically based on working directory.
                  </p>
                </div>
              </div>

              <div className="flex gap-4">
                <div className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center mt-0.5" style={{ backgroundColor: 'hsl(var(--muted))' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6D657A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="12 2 2 7 12 12 22 7 12 2" />
                    <polyline points="2 17 12 22 22 17" />
                    <polyline points="2 12 12 17 22 12" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-base font-semibold mb-1" style={{ color: '#3A3542' }}>Spec-Driven Architecture</h3>
                  <p className="text-sm leading-relaxed" style={{ color: '#5A5266' }}>
                    Every system — from the Plaid webhook engine to the pgvector classification pipeline — was
                    documented in isolated markdown specs before a line of code was written.{' '}
                    <Link href="/docs/specifications" className="underline underline-offset-2 transition-colors hover:text-[#3A3542]" style={{ color: '#6D657A' }}>
                      43 specification files
                    </Link>{' '}
                    across 3 layers.
                  </p>
                </div>
              </div>

              <div className="flex gap-4">
                <div className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center mt-0.5" style={{ backgroundColor: 'hsl(var(--muted))' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6D657A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="16 18 22 12 16 6" />
                    <polyline points="8 6 2 12 8 18" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-base font-semibold mb-1" style={{ color: '#3A3542' }}>Type-Safe Boundaries</h3>
                  <p className="text-sm leading-relaxed" style={{ color: '#5A5266' }}>
                    Strict Prisma schemas and validated API contracts ensure AI-generated code
                    won&apos;t break the data model. 50+ migrations maintain schema integrity across every change.
                  </p>
                </div>
              </div>

              <div className="flex gap-4">
                <div className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center mt-0.5" style={{ backgroundColor: 'hsl(var(--muted))' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6D657A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-base font-semibold mb-1" style={{ color: '#3A3542' }}>OpenAPI-Documented Endpoints</h3>
                  <p className="text-sm leading-relaxed" style={{ color: '#5A5266' }}>
                    Every API surface is documented in OpenAPI 3.0 YAML specs — 19 files covering authentication,
                    transactions, portfolios, imports, and more. Browse them interactively in the{' '}
                    <Link href="/docs/api-reference" className="underline underline-offset-2 transition-colors hover:text-[#3A3542]" style={{ color: '#6D657A' }}>
                      API Reference
                    </Link>.
                  </p>
                </div>
              </div>
            </div>

            {/* Right: Terminal window showing CLAUDE.md usage */}
            <div className="flex-1 w-full lg:max-w-lg">
              <div className="rounded-xl overflow-hidden" style={{ backgroundColor: '#1E1E1E' }}>
                {/* macOS dots */}
                <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: '1px solid #333' }}>
                  <span className="w-3 h-3 rounded-full" style={{ backgroundColor: '#FF5F56' }} />
                  <span className="w-3 h-3 rounded-full" style={{ backgroundColor: '#FFBD2E' }} />
                  <span className="w-3 h-3 rounded-full" style={{ backgroundColor: '#27C93F' }} />
                  <span className="ml-3 text-xs" style={{ color: '#888' }}>~/bliss</span>
                </div>
                <div className="p-5 overflow-x-auto">
                  <pre className="text-xs leading-relaxed font-mono" style={{ color: '#D4D4D4' }}>
{`$ claude

`}<span style={{ color: '#27C93F' }}>{'>'}</span>{` Loading project context...

`}<span style={{ color: '#888' }}>{`  ✓ CLAUDE.md (root)        — architecture, critical rules
  ✓ apps/api/CLAUDE.md      — route patterns, auth flow
  ✓ apps/backend/CLAUDE.md  — worker patterns, services
  ✓ apps/web/CLAUDE.md      — design tokens, components
  ✓ apps/docs/CLAUDE.md     — sync script, Nextra`}</span>{`

`}<span style={{ color: '#27C93F' }}>{'>'}</span>{` Context loaded. `}<span style={{ color: '#6D657A' }}>5 files</span>{`, `}<span style={{ color: '#6D657A' }}>43 specs</span>{`, `}<span style={{ color: '#6D657A' }}>1,076 tests</span>{`

`}<span style={{ color: '#FFBD2E' }}>{'$'}</span>{` How can I help with Bliss?`}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ━━ SECTION 7: Footer CTA ━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <section className="py-20 md:py-28" style={{ borderTop: '1px solid #E2E8F0' }}>
        <div className="max-w-3xl mx-auto px-6 text-center">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-8" style={{ color: '#3A3542' }}>
            Ready to deploy your sanctuary?
          </h2>
          <div className="flex flex-col items-center gap-4">
            <a
              href="https://github.com/danielvsantos/bliss"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-8 py-4 rounded-xl font-semibold text-base transition-colors hover:bg-[#2A2631]"
              style={{ backgroundColor: '#3A3542', color: '#fff' }}
            >
              <GitHubIcon size={18} />
              View the GitHub Repository
            </a>
            <Link
              href="/docs/guides/docker-quickstart"
              className="inline-flex items-center px-8 py-4 rounded-xl font-semibold text-sm transition-colors hover:bg-gray-50"
              style={{ backgroundColor: '#fff', border: '1px solid #CBD5E1', color: '#5A5266' }}
            >
              Read the Docker Quickstart Guide
            </Link>
          </div>
        </div>
      </section>

      {/* ── Footer ─────────────────────────────────────────── */}
      <footer className="py-10" style={{ borderTop: '1px solid #E2E8F0' }}>
        <div className="max-w-6xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4">
          <span className="text-sm" style={{ color: '#5A5266' }}>
            {new Date().getFullYear()} Bliss Finance. Open-source under AGPL-3.0 License.
          </span>
          <div className="flex items-center gap-6">
            <Link href="/docs" className="text-sm transition-colors hover:text-[#3A3542]" style={{ color: '#6D657A' }}>Docs</Link>
            <a href="https://github.com/danielvsantos/bliss" target="_blank" rel="noopener noreferrer" className="text-sm transition-colors hover:text-[#3A3542]" style={{ color: '#6D657A' }}>GitHub</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
