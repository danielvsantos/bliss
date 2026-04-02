'use client';

import { ApiReferenceReact } from '@scalar/api-reference-react';

const SPECS = [
  { id: 'auth', label: 'Authentication', file: 'auth.yaml' },
  { id: 'accounts', label: 'Accounts', file: 'accounts.yaml' },
  { id: 'transactions', label: 'Transactions', file: 'transactions.yaml' },
  { id: 'portfolio', label: 'Portfolio', file: 'portfolio.yaml' },
  { id: 'analytics', label: 'Analytics', file: 'analytics.yaml' },
  { id: 'imports', label: 'Smart Import', file: 'imports.yaml' },
  { id: 'plaid', label: 'Plaid Integration', file: 'plaid.yaml' },
  { id: 'category', label: 'Categories', file: 'category.yaml' },
  { id: 'tags', label: 'Tags', file: 'tags.yaml' },
  { id: 'insights', label: 'Insights', file: 'insights.yaml' },
  { id: 'admin', label: 'Admin', file: 'admin.yaml' },
  { id: 'tenants', label: 'Tenants', file: 'tenants.yaml' },
  { id: 'onboarding', label: 'Onboarding', file: 'onboarding.yaml' },
  { id: 'notifications', label: 'Notifications', file: 'notifications.yaml' },
  { id: 'users', label: 'Users', file: 'users.yaml' },
  { id: 'banks', label: 'Banks', file: 'banks.yaml' },
  { id: 'currency-rates', label: 'Currency Rates', file: 'currency-rates.yaml' },
  { id: 'ticker', label: 'Ticker Search', file: 'ticker.yaml' },
  { id: 'equity-analysis', label: 'Equity Analysis', file: 'equity-analysis.yaml' },
  { id: 'reference-data', label: 'Reference Data', file: 'reference-data.yaml' },
  { id: 'backend', label: 'Backend (Internal)', file: 'backend.yaml' },
];

export function ApiReference() {
  return (
    <div
      style={{
        border: '1px solid hsl(214 31% 91%)',
        borderRadius: '12px',
        overflow: 'hidden',
        minHeight: '600px',
      }}
    >
      <ApiReferenceReact
        configuration={{
          sources: SPECS.map((s) => ({
            url: `/openapi/${s.file}`,
            title: s.label,
            slug: s.id,
          })),
          hideModels: false,
          hideDownloadButton: false,
        }}
      />
    </div>
  );
}
