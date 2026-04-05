import type { Metadata } from 'next';
import { Urbanist } from 'next/font/google';
import { Head } from 'nextra/components';
import { ThemeProvider } from 'next-themes';
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
    default: 'Bliss Finance — Open-Source Wealth Intelligence Platform',
    template: '%s — Bliss Finance',
  },
  description:
    'Self hosted multi-currency personal wealth intelligence platform with AI-powered transaction classification, portfolio tracking, and financial insights.',
  icons: {
    icon: '/favicon.ico',
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
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
