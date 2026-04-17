import type { Metadata } from 'next';
import { Urbanist } from 'next/font/google';
import Script from 'next/script';
import { Head } from 'nextra/components';

import './globals.css';
import 'nextra-theme-docs/style-prefixed.css';
import './docs-overrides.css';

const urbanist = Urbanist({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-urbanist',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Bliss — Open-Source Wealth Intelligence Platform',
    template: '%s — Bliss',
  },
  description:
    'Self hosted multi-currency personal wealth intelligence platform with AI-powered transaction classification, portfolio tracking, and financial insights.',
  icons: {
    icon: '/icon.png',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning className={urbanist.variable}>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      </Head>
      <body style={{ fontFamily: 'var(--font-urbanist), Urbanist, sans-serif' }}>
        <Script
          async
          src="https://plausible.io/js/pa-d_JvWNrshiN5VKD6KrxVw.js"
          strategy="afterInteractive"
        />
        <Script id="plausible-init" strategy="afterInteractive">
          {`window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()`}
        </Script>
        {children}
      </body>
    </html>
  );
}
