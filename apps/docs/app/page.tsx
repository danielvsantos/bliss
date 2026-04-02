'use client';

import { useState } from 'react';
import Link from 'next/link';
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
    title: '4-Tier AI Classification',
    description:
      'Exact match, vector similarity (pgvector), cross-tenant global embeddings, and LLM fallback. Learns from every user correction.',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22" />
        <path d="M12 2a4 4 0 0 0-4 4c0 1.95 1.4 3.58 3.25 3.93" />
        <path d="M8.56 13a8 8 0 0 0-2.3 3.5" />
        <path d="M15.44 13a8 8 0 0 1 2.3 3.5" />
      </svg>
    ),
  },
  {
    title: 'Multi-Currency Portfolio',
    description:
      'FIFO lot tracking with historical FX rates. Real-time pricing via Twelve Data and Finnhub. Stocks, crypto, funds, and fixed-income.',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polyline points="22,7 13.5,15.5 8.5,10.5 2,17" />
        <polyline points="16,7 22,7 22,13" />
      </svg>
    ),
  },
  {
    title: 'Event-Driven Architecture',
    description:
      'BullMQ workers process classification, portfolio valuation, analytics aggregation, and AI insights generation asynchronously.',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
      </svg>
    ),
  },
  {
    title: 'Smart Import Pipeline',
    description:
      'CSV/XLSX ingestion with adapter detection, SHA-256 deduplication, AI classification, and batch commit with tag resolution.',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="12" y1="18" x2="12" y2="12" />
        <polyline points="9 15 12 12 15 15" />
      </svg>
    ),
  },
  {
    title: 'Plaid Integration',
    description:
      'Two-worker sync system with cursor-based pagination, hash-based dedup, encrypted raw payloads, and automatic classification.',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M2 10h20" />
        <path d="M6 14h4" />
      </svg>
    ),
  },
  {
    title: 'Financial Insights Engine',
    description:
      '7 financial lenses powered by AI: spending velocity, category concentration, income stability, savings rate, portfolio exposure, and more.',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M2 20h20" />
        <path d="M5 20V10" />
        <path d="M9 20V4" />
        <path d="M13 20v-8" />
        <path d="M17 20V8" />
        <path d="M21 20v-5" />
      </svg>
    ),
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
        <div className="max-w-6xl mx-auto px-6 pt-24 pb-20 md:pt-32 md:pb-28">
          <div className="max-w-3xl">
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
              Wealth Intelligence,{' '}
              <span style={{ color: 'hsl(var(--brand-primary))' }}>Engineered</span>
            </h1>
            <p
              className="mt-6 text-lg md:text-xl leading-relaxed max-w-2xl"
              style={{ color: 'hsl(var(--muted-foreground))' }}
            >
              A multi-currency personal finance platform with AI-powered transaction
              classification, real-time portfolio tracking, and event-driven analytics.
              Built for self-hosting.
            </p>
            <div className="mt-10 flex flex-wrap gap-4">
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
                Explore Documentation
              </Link>
            </div>
          </div>
        </div>

        {/* Background gradient decoration */}
        <div
          className="absolute -top-40 -right-40 w-96 h-96 rounded-full opacity-20 blur-3xl pointer-events-none"
          style={{ backgroundColor: 'hsl(var(--brand-primary))' }}
        />
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

      {/* ── Features ───────────────────────────────────────── */}
      <section
        className="py-16 md:py-20"
        style={{ borderTop: '1px solid hsl(var(--border))' }}
      >
        <div className="max-w-6xl mx-auto px-6">
          <h2
            className="text-2xl md:text-3xl font-bold tracking-tight mb-4"
            style={{ color: 'hsl(var(--brand-deep))' }}
          >
            Key Subsystems
          </h2>
          <p className="text-base mb-10 max-w-2xl" style={{ color: 'hsl(var(--muted-foreground))' }}>
            Production-grade features designed for reliability, performance, and extensibility.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {FEATURES.map((feature) => (
              <div key={feature.title} className="glass-card p-6">
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
                  style={{
                    backgroundColor: 'hsl(var(--accent))',
                    color: 'hsl(var(--brand-primary))',
                  }}
                >
                  {feature.icon}
                </div>
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
            ))}
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
