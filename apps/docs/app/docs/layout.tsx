import { Footer, Layout, Navbar } from 'nextra-theme-docs';
import { getPageMap } from 'nextra/page-map';

const logo = (
  <span
    className="font-semibold text-lg tracking-tight"
    style={{ color: 'hsl(263 11% 23%)' }}
  >
    Bliss<span style={{ color: 'hsl(263 9% 43%)' }}>Finance</span>
  </span>
);

export default async function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Layout
      navbar={
        <Navbar
          logo={logo}
          projectLink="https://github.com/danielviana/bliss"
        />
      }
      pageMap={await getPageMap('/docs')}
      docsRepositoryBase="https://github.com/danielviana/bliss/tree/main/apps/docs"
      footer={
        <Footer>
          <span className="text-sm" style={{ color: 'hsl(260 6% 61%)' }}>
            {new Date().getFullYear()} Bliss Finance. Open-source under MIT
            License.
          </span>
        </Footer>
      }
    >
      {children}
    </Layout>
  );
}
