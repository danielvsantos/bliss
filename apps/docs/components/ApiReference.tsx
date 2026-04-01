'use client';

import { useState } from 'react';
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
  const [activeSpec, setActiveSpec] = useState(SPECS[0].id);
  const current = SPECS.find((s) => s.id === activeSpec)!;

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '24px' }}>
        {SPECS.map((spec) => (
          <button
            key={spec.id}
            onClick={() => setActiveSpec(spec.id)}
            style={{
              padding: '6px 14px',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: activeSpec === spec.id ? 600 : 400,
              fontFamily: 'Urbanist, sans-serif',
              border: '1px solid',
              borderColor: activeSpec === spec.id ? 'hsl(263 11% 23%)' : 'hsl(214 31% 91%)',
              backgroundColor: activeSpec === spec.id ? 'hsl(263 11% 23%)' : 'transparent',
              color: activeSpec === spec.id ? '#fff' : 'hsl(263 11% 23%)',
              cursor: 'pointer',
              transition: 'all 150ms ease',
            }}
          >
            {spec.label}
          </button>
        ))}
      </div>

      <div
        style={{
          border: '1px solid hsl(214 31% 91%)',
          borderRadius: '12px',
          overflow: 'hidden',
          minHeight: '600px',
        }}
      >
        <ApiReferenceReact
          key={current.id}
          configuration={{
            spec: {
              url: `/openapi/${current.file}`,
            },
            hideModels: false,
            hideDownloadButton: false,
            theme: 'default',
          }}
        />
      </div>
    </div>
  );
}
