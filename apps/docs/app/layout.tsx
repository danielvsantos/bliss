import type { Metadata } from 'next';
import { Urbanist } from 'next/font/google';
import { Footer, Layout, Navbar } from 'nextra-theme-docs';
import { Head } from 'nextra/components';
import { getPageMap } from 'nextra/page-map';
import 'nextra-theme-docs/style-prefixed.css';
import './globals.css';

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
    'Multi-currency personal wealth intelligence platform with AI-powered transaction classification, portfolio tracking, and financial insights.',
  icons: {
    icon: '/favicon.ico',
  },
};

const logo = (
  <span className="font-semibold text-lg tracking-tight" style={{ color: 'hsl(263 11% 23%)' }}>
    Bliss<span style={{ color: 'hsl(263 9% 43%)' }}>Finance</span>
  </span>
);

export default async function RootLayout({
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
        <Layout
          navbar={
            <Navbar
              logo={logo}
              projectLink="https://github.com/danielviana/bliss"
            />
          }
          pageMap={await getPageMap()}
          docsRepositoryBase="https://github.com/danielviana/bliss/tree/main/apps/docs"
          footer={
            <Footer>
              <span className="text-muted-fg text-sm">
                {new Date().getFullYear()} Bliss Finance. Open-source under MIT License.
              </span>
            </Footer>
          }
        >
          {children}
        </Layout>
      </body>
    </html>
  );
}
