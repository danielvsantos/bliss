'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';

/* ── Plaid logo (official SVG mark) ──────────────────────── */
const PlaidLogo = ({ size = 28 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
    <path d="M20.64 0H27.36L32.16 4.8H25.44L20.64 0Z" fill="#111111"/>
    <path d="M15.84 4.8H22.56L27.36 9.6H20.64L15.84 4.8Z" fill="#111111"/>
    <path d="M11.04 9.6H17.76L22.56 14.4H15.84L11.04 9.6Z" fill="#111111"/>
    <path d="M32.16 4.8H38.88L43.68 9.6H36.96L32.16 4.8Z" fill="#111111"/>
    <path d="M27.36 9.6H34.08L38.88 14.4H32.16L27.36 9.6Z" fill="#111111"/>
    <path d="M22.56 14.4H29.28L34.08 19.2H27.36L22.56 14.4Z" fill="#111111"/>
    <path d="M6.24 14.4H12.96L17.76 19.2H11.04L6.24 14.4Z" fill="#111111"/>
    <path d="M17.76 19.2H24.48L29.28 24H22.56L17.76 19.2Z" fill="#111111"/>
    <path d="M11.04 19.2H4.32L-0.48 24H6.24L11.04 19.2Z" fill="#111111"/>
    <path d="M22.56 24H15.84L11.04 28.8H17.76L22.56 24Z" fill="#111111"/>
    <path d="M29.28 24H22.56L17.76 28.8H24.48L29.28 24Z" fill="#111111"/>
    <path d="M34.08 28.8H27.36L22.56 33.6H29.28L34.08 28.8Z" fill="#111111"/>
    <path d="M17.76 28.8H11.04L6.24 33.6H12.96L17.76 28.8Z" fill="#111111"/>
    <path d="M38.88 33.6H32.16L27.36 38.4H34.08L38.88 33.6Z" fill="#111111"/>
    <path d="M12.96 33.6H6.24L1.44 38.4H8.16L12.96 33.6Z" fill="#111111"/>
    <path d="M29.28 33.6H22.56L17.76 38.4H24.48L29.28 33.6Z" fill="#111111"/>
    <path d="M43.68 38.4H36.96L32.16 43.2H38.88L43.68 38.4Z" fill="#111111"/>
    <path d="M34.08 38.4H27.36L22.56 43.2H29.28L34.08 38.4Z" fill="#111111"/>
    <path d="M27.36 43.2H20.64L15.84 48H22.56L27.36 43.2Z" fill="#111111"/>
  </svg>
);

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

/* ── Star icon ───────────────────────────────────────────── */
const StarIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
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
            <Link href="/docs" className="text-sm font-medium transition-opacity hover:opacity-80" style={{ color: '#3A3542' }}>
              Documentation
            </Link>
            <Link href="/docs/api-reference" className="text-sm font-medium transition-opacity hover:opacity-80" style={{ color: '#3A3542' }}>
              API Reference
            </Link>
            <a
              href="https://app.blissfinance.co/auth?origin=docs-site"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-90"
              style={{ backgroundColor: '#3A3542', color: '#fff' }}
            >
              Live Demo
            </a>
            <a
              href="https://github.com/danielvsantos/bliss"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-opacity hover:opacity-80"
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
            <div className="flex-1 text-center md:text-left">
              <div
                className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium mb-6"
                style={{ backgroundColor: 'hsl(var(--accent))', color: '#6D657A' }}
              >
                Open Source
              </div>
              <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight leading-tight" style={{ color: '#3A3542' }}>
                Self-Hosted Personal Finance{' '}
                <span style={{ color: '#6D657A' }}>for Global Citizens</span>
              </h1>
              <p className="mt-6 text-lg md:text-xl leading-relaxed max-w-2xl" style={{ color: '#6D657A' }}>
                AI-powered transaction classification, real-time portfolio tracking, and event-driven analytics.
                Secured by AES-256 encryption. Built for self-hosting. Designed for global finances.
              </p>

              {/* CTAs — stack vertically on mobile */}
              <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center md:justify-start">
                <Link
                  href="/docs/guides/docker-quickstart"
                  className="inline-flex items-center justify-center px-7 py-3.5 rounded-xl font-semibold text-sm transition-all hover:opacity-90"
                  style={{ backgroundColor: '#3A3542', color: '#fff' }}
                >
                  Get Started
                </Link>
                <a
                  href="https://github.com/danielvsantos/bliss"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl font-semibold text-sm transition-all hover:opacity-80"
                  style={{ border: '1px solid #E2E8F0', color: '#3A3542' }}
                >
                  <GitHubIcon size={16} />
                  GitHub
                </a>
                <a
                  href="https://app.blissfinance.co/auth?origin=docs-site"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center px-7 py-3.5 rounded-xl font-semibold text-sm transition-all hover:opacity-80"
                  style={{ border: '1px solid #E2E8F0', color: '#6D657A' }}
                >
                  Live Demo
                </a>
              </div>

              {/* Social proof — GitHub star link */}
              <div className="mt-6 flex items-center justify-center md:justify-start">
                <a
                  href="https://github.com/danielvsantos/bliss"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs font-medium transition-opacity hover:opacity-70"
                  style={{ color: '#6D657A' }}
                >
                  <StarIcon size={14} />
                  Star on GitHub
                </a>
              </div>
            </div>

            {/* Mascot — slightly smaller on desktop */}
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
            Three services. Ten asynchronous workers. One configuration file.
          </h2>
          <p className="text-sm leading-relaxed mb-10 max-w-2xl" style={{ color: '#6D657A' }}>
            A monorepo architecture designed for privacy-first self-hosting.
          </p>

          {/* Desktop: SVG architecture diagram — tighter padding */}
          <div className="hidden lg:block glass-card p-3 overflow-hidden" style={{ backgroundColor: '#fff' }}>
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
          </div>
        </div>
      </section>

      {/* ━━ SECTION 3: Intelligence Pipeline (Bento Box) ━━━ */}
      <section className="py-16 md:py-24" style={{ borderTop: '1px solid #E2E8F0' }}>
        <div className="max-w-6xl mx-auto px-6">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight mb-3" style={{ color: '#3A3542' }}>
            Eradicate Manual Data Entry
          </h2>
          <p className="text-base leading-relaxed mb-12 max-w-3xl" style={{ color: '#6D657A' }}>
            A multi-tier classification waterfall deterministically routes and categorizes your
            transactions without relying entirely on expensive LLM calls.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Box 1: Classification Engine (large, left, spans 2 rows) */}
            <div className="glass-card overflow-hidden md:row-span-2 flex flex-col">
              <div className="p-6 pb-4">
                <h3 className="text-lg font-semibold mb-3" style={{ color: '#3A3542' }}>
                  4-Tier Classification Engine
                </h3>
                <p className="text-sm leading-relaxed" style={{ color: '#6D657A' }}>
                  A deterministic AI waterfall eradicates manual entry. Transactions cascade through an
                  exact-match Redis cache, a pgvector similarity search, and a Gemini LLM fallback. User
                  corrections automatically generate new vector embeddings, creating a reinforcement learning loop.
                </p>
              </div>
              {/* Full-bleed screenshot with floating AI badge */}
              <div className="relative mt-auto flex-1 min-h-[200px]">
                <Image
                  src="/images/classification.png"
                  alt="Transaction review showing AI classification with confidence scoring"
                  width={600}
                  height={400}
                  className="w-full h-full object-cover object-top"
                />
                {/* Floating AI badge overlay */}
                <div
                  className="absolute top-4 right-4"
                  style={{
                    boxShadow: '0 8px 24px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)',
                    borderRadius: '12px',
                    overflow: 'hidden',
                    maxWidth: '55%',
                  }}
                >
                  <Image
                    src="/images/aibadge.png"
                    alt="Bliss Analysis: 88% AI Confidence badge"
                    width={280}
                    height={140}
                    className="w-full h-auto"
                  />
                </div>
              </div>
            </div>

            {/* Box 2: Secure Institution Sync (small, top right) */}
            <div className="glass-card p-6 flex flex-col">
              <div className="flex items-center gap-3 mb-4">
                <PlaidLogo size={28} />
                <h3 className="text-lg font-semibold" style={{ color: '#3A3542' }}>
                  Secure Institution Sync
                </h3>
              </div>
              <p className="text-sm leading-relaxed mb-6" style={{ color: '#6D657A' }}>
                Robust Plaid webhook ingestion handles encrypted payload staging, optimistic account linking,
                and automated token rotation.
              </p>
              {/* Icon lockup: Plaid → arrow → Bliss */}
              <div className="mt-auto flex items-center justify-center gap-6 py-6" style={{ backgroundColor: 'hsl(var(--muted))', borderRadius: '12px' }}>
                <div className="flex flex-col items-center gap-2">
                  <div className="w-14 h-14 rounded-2xl bg-white flex items-center justify-center" style={{ border: '1px solid #E2E8F0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                    <PlaidLogo size={24} />
                  </div>
                  <span className="text-[10px] font-medium" style={{ color: '#6D657A' }}>Plaid</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <svg width="32" height="16" viewBox="0 0 32 16" fill="none">
                    <path d="M0 8h28M24 3l4 5-4 5" stroke="#6D657A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="text-[9px] font-medium" style={{ color: '#6D657A' }}>AES-256</span>
                </div>
                <div className="flex flex-col items-center gap-2">
                  <div className="w-14 h-14 rounded-2xl bg-white flex items-center justify-center" style={{ border: '1px solid #E2E8F0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                    <span style={{ fontFamily: "'Urbanist', sans-serif", fontSize: '0.875rem', fontWeight: 600, color: '#6D657A', letterSpacing: '-0.03em' }}>bliss</span>
                  </div>
                  <span className="text-[10px] font-medium" style={{ color: '#6D657A' }}>Bliss</span>
                </div>
              </div>
            </div>

            {/* Box 3: Extensible File Ingestion (small, bottom right) */}
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
                <p className="text-sm leading-relaxed" style={{ color: '#6D657A' }}>
                  A streaming engine detects CSV/XLSX schemas and executes SHA-256 row deduplication.
                  Easily write custom TypeScript adapters to ingest data from unsupported regional banks or legacy systems.
                </p>
              </div>
              {/* Right-bleeding adapter screenshot */}
              <div className="mt-auto overflow-hidden" style={{ marginLeft: '24px', marginBottom: '-1px' }}>
                <Image
                  src="/images/smartimportadapter.png"
                  alt="Smart Import adapter creation modal showing column mapping configuration"
                  width={500}
                  height={350}
                  className="w-full h-auto rounded-tl-lg"
                  style={{ objectFit: 'cover', objectPosition: 'top left' }}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ━━ SECTION 4: Global Ledger (Split View) ━━━━━━━━━━ */}
      <section className="py-16 md:py-24" style={{ borderTop: '1px solid #E2E8F0' }}>
        <div className="max-w-6xl mx-auto px-6">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight mb-3" style={{ color: '#3A3542' }}>
            Multi-Currency Wealth, Unified.
          </h2>
          <p className="text-base leading-relaxed mb-12 max-w-3xl" style={{ color: '#6D657A' }}>
            Built from the ground up for cross-border portfolios. Backend asynchronous workers calculate
            historical exchange rates, ensuring your frontend dashboard never has to perform currency math on the fly.
          </p>

          <div className="flex flex-col lg:flex-row gap-10 items-center">
            {/* Left: Layered image composition */}
            <div className="flex-1 w-full">
              <div className="relative">
                <div className="glass-card overflow-hidden">
                  <Image
                    src="/images/portfolio.png"
                    alt="Bliss portfolio dashboard showing multi-currency holdings, asset allocation, and performance charts"
                    width={700}
                    height={500}
                    className="w-full h-auto"
                  />
                </div>
                {/* Floating P&L overlay — visible on all viewports */}
                <div
                  className="hidden sm:block absolute bottom-4 right-4 rounded-xl overflow-hidden"
                  style={{
                    boxShadow: '0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)',
                    border: '1px solid #E2E8F0',
                    maxWidth: '50%',
                  }}
                >
                  <Image
                    src="/images/pnltighcrop.png"
                    alt="Multi-currency P&L breakdown overlay"
                    width={320}
                    height={240}
                    className="w-full h-auto"
                  />
                </div>
              </div>
              {/* Mobile: P&L shown below main image */}
              <div className="sm:hidden mt-4 glass-card overflow-hidden">
                <Image
                  src="/images/pnltighcrop.png"
                  alt="Multi-currency P&L breakdown"
                  width={400}
                  height={300}
                  className="w-full h-auto"
                />
              </div>
            </div>

            {/* Right: Features */}
            <div className="flex-1">
              <div className="space-y-8">
                <div>
                  <h3 className="text-base font-semibold mb-2" style={{ color: '#3A3542' }}>
                    The Unified P&L Engine
                  </h3>
                  <p className="text-sm leading-relaxed" style={{ color: '#6D657A' }}>
                    Automatically normalizes income and expenses across borders using historical FX rates
                    to give you a single base-currency view of your entire financial life.
                  </p>
                </div>

                <div>
                  <h3 className="text-base font-semibold mb-2" style={{ color: '#3A3542' }}>
                    Real-Time Portfolio Tracking
                  </h3>
                  <p className="text-sm leading-relaxed" style={{ color: '#6D657A' }}>
                    Asynchronous workers track FIFO lots and integrate directly with the Twelve Data API
                    for live stock/ETF prices. Historical cost-basis calculations happen in the background,
                    never blocking your dashboard.
                  </p>
                </div>

                <div>
                  <h3 className="text-base font-semibold mb-2" style={{ color: '#3A3542' }}>
                    Event-Driven Analytics
                  </h3>
                  <p className="text-sm leading-relaxed" style={{ color: '#6D657A' }}>
                    Every transaction triggers a scoped analytics update. Monthly aggregations across categories,
                    tags, currencies, and countries are computed incrementally — never a full table scan.
                  </p>
                </div>

                <Link
                  href="/docs/specifications"
                  className="inline-flex items-center gap-1 text-sm font-medium transition-opacity hover:opacity-80"
                  style={{ color: '#6D657A' }}
                >
                  View specifications <ArrowRight />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ━━ SECTION 5: Production-Grade Infrastructure ━━━━━ */}
      <section className="py-16 md:py-24" style={{ borderTop: '1px solid #E2E8F0' }}>
        <div className="max-w-6xl mx-auto px-6">
          {/* Bumped to text-3xl/4xl — strongest copy on the page */}
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-3" style={{ color: '#3A3542' }}>
            Built for the Homelab. Engineered for the Enterprise.
          </h2>
          <p className="text-base leading-relaxed mb-12 max-w-3xl" style={{ color: '#6D657A' }}>
            A decoupled architecture ensuring absolute privacy, rock-solid stability, and the ability
            to host multiple users from a single deployment.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Column 1: Multi-Tenant — larger icon */}
            <div className="glass-card p-6">
              <div className="w-16 h-16 rounded-xl flex items-center justify-center mb-5" style={{ backgroundColor: 'hsl(var(--accent))' }}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#6D657A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <h3 className="text-base font-semibold mb-2" style={{ color: '#3A3542' }}>
                Multi-Tenant by Design
              </h3>
              <p className="text-sm leading-relaxed" style={{ color: '#6D657A' }}>
                Host completely isolated financial environments for your friends, family, or partner from a
                single deployment using strict query-level tenant isolation.
              </p>
            </div>

            {/* Column 2: Encryption — larger icon */}
            <div className="glass-card p-6">
              <div className="w-16 h-16 rounded-xl flex items-center justify-center mb-5" style={{ backgroundColor: 'hsl(var(--accent))' }}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#6D657A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </div>
              <h3 className="text-base font-semibold mb-2" style={{ color: '#3A3542' }}>
                AES-256-GCM Encryption
              </h3>
              <p className="text-sm leading-relaxed" style={{ color: '#6D657A' }}>
                Your sensitive data — including Plaid access tokens and raw bank payloads — is encrypted
                at rest, ensuring your financial footprint remains strictly yours.
              </p>
            </div>

            {/* Column 3: Reliability — CI image as cover photo */}
            <div className="glass-card overflow-hidden flex flex-col">
              {/* Cover photo: full-bleed CI image */}
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
                <p className="text-sm leading-relaxed" style={{ color: '#6D657A' }}>
                  Orchestrated by 10 independent BullMQ workers and protected by over 1,000 automated CI pipeline tests.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ━━ SECTION 6: Footer CTA ━━━━━━━━━━━━━━━━━━━━━━━━━ */}
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
              className="inline-flex items-center gap-2 px-8 py-4 rounded-xl font-semibold text-base transition-all hover:opacity-90"
              style={{ backgroundColor: '#3A3542', color: '#fff' }}
            >
              <GitHubIcon size={18} />
              View the GitHub Repository
            </a>
            <Link
              href="/docs/guides/docker-quickstart"
              className="inline-flex items-center px-8 py-4 rounded-xl font-semibold text-sm transition-all hover:opacity-80"
              style={{ backgroundColor: '#fff', border: '1px solid #CBD5E1', color: '#6D657A' }}
            >
              Read the Docker Quickstart Guide
            </Link>
          </div>
        </div>
      </section>

      {/* ── Footer ─────────────────────────────────────────── */}
      <footer className="py-10" style={{ borderTop: '1px solid #E2E8F0' }}>
        <div className="max-w-6xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4">
          <span className="text-sm" style={{ color: '#6D657A' }}>
            {new Date().getFullYear()} Bliss Finance. Open-source under AGPL-3.0 License.
          </span>
          <div className="flex items-center gap-6">
            <Link href="/docs" className="text-sm transition-opacity hover:opacity-80" style={{ color: '#6D657A' }}>Docs</Link>
            <a href="https://github.com/danielvsantos/bliss" target="_blank" rel="noopener noreferrer" className="text-sm transition-opacity hover:opacity-80" style={{ color: '#6D657A' }}>GitHub</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
