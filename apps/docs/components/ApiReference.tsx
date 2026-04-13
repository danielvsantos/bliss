'use client';

import { useState } from 'react';
import '@scalar/api-reference-react/style.css';
import { ApiReferenceReact } from '@scalar/api-reference-react';

interface Spec {
  id: string;
  label: string;
  file: string;
}

const CATEGORIES: { name: string; specs: Spec[] }[] = [
  {
    name: 'Core',
    specs: [
      { id: 'auth', label: 'Authentication', file: 'auth.yaml' },
      { id: 'accounts', label: 'Accounts', file: 'accounts.yaml' },
      { id: 'transactions', label: 'Transactions', file: 'transactions.yaml' },
      { id: 'category', label: 'Categories', file: 'category.yaml' },
      { id: 'tags', label: 'Tags', file: 'tags.yaml' },
    ],
  },
  {
    name: 'Finance',
    specs: [
      { id: 'portfolio', label: 'Portfolio', file: 'portfolio.yaml' },
      { id: 'analytics', label: 'Analytics', file: 'analytics.yaml' },
      { id: 'insights', label: 'Insights', file: 'insights.yaml' },
      { id: 'equity-analysis', label: 'Equity Analysis', file: 'equity-analysis.yaml' },
    ],
  },
  {
    name: 'Import',
    specs: [
      { id: 'imports', label: 'Smart Import', file: 'imports.yaml' },
      { id: 'plaid', label: 'Plaid Integration', file: 'plaid.yaml' },
    ],
  },
  {
    name: 'Reference',
    specs: [
      { id: 'banks', label: 'Banks', file: 'banks.yaml' },
      { id: 'currency-rates', label: 'Currency Rates', file: 'currency-rates.yaml' },
      { id: 'ticker', label: 'Ticker Search', file: 'ticker.yaml' },
      { id: 'reference-data', label: 'Reference Data', file: 'reference-data.yaml' },
    ],
  },
  {
    name: 'Admin',
    specs: [
      { id: 'admin', label: 'Admin', file: 'admin.yaml' },
      { id: 'tenants', label: 'Tenants', file: 'tenants.yaml' },
      { id: 'onboarding', label: 'Onboarding', file: 'onboarding.yaml' },
      { id: 'notifications', label: 'Notifications', file: 'notifications.yaml' },
      { id: 'users', label: 'Users', file: 'users.yaml' },
    ],
  },
  {
    name: 'Internal',
    specs: [
      { id: 'backend', label: 'Backend', file: 'backend.yaml' },
    ],
  },
];

const ALL_SPECS = CATEGORIES.flatMap((c) => c.specs);

export function ApiReference() {
  const [selectedId, setSelectedId] = useState('auth');
  const active = ALL_SPECS.find((s) => s.id === selectedId) ?? ALL_SPECS[0];

  return (
    <div>
      <div className="spec-selector">
        {CATEGORIES.map((cat) => (
          <div key={cat.name} className="spec-category">
            <span className="spec-category-label">{cat.name}</span>
            <div className="spec-pills">
              {cat.specs.map((spec) => (
                <button
                  key={spec.id}
                  className={`spec-pill ${spec.id === selectedId ? 'spec-pill-active' : ''}`}
                  onClick={() => setSelectedId(spec.id)}
                >
                  {spec.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="scalar-wrapper" key={selectedId}>
        <ApiReferenceReact
          configuration={{
            sources: [
              {
                url: `/openapi/${active.file}`,
                title: active.label,
                slug: active.id,
              },
            ],
            hideModels: false,
            hideDownloadButton: false,
          }}
        />
      </div>
    </div>
  );
}
