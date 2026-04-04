'use client';

import { useEffect, useState } from 'react';

const GITHUB_BASE = 'https://github.com/danielvsantos/bliss/blob/main';

const LAYER_META: Record<string, { label: string; color: string }> = {
  api:      { label: 'API',      color: 'hsl(263 9% 43%)' },
  backend:  { label: 'Backend',  color: 'hsl(210 60% 45%)' },
  frontend: { label: 'Frontend', color: 'hsl(150 45% 40%)' },
};

interface Feature {
  slug: string;
  title: string;
  description: string;
  order: number;
  layers: Record<string, string>;
}

export function SpecificationsGrid() {
  const [features, setFeatures] = useState<Feature[]>([]);

  useEffect(() => {
    fetch('/specs-manifest.json')
      .then((r) => r.json())
      .then((data: Feature[]) => setFeatures(data))
      .catch(() => {});
  }, []);

  if (features.length === 0) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: 'hsl(260 6% 61%)' }}>
        Loading specifications...
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '20px' }}>
      {features.map((feature) => (
        <div
          key={feature.slug}
          style={{
            border: '1px solid hsl(var(--border))',
            borderRadius: '12px',
            padding: '20px',
            backgroundColor: 'hsl(var(--card, var(--background)))',
          }}
        >
          <h3 style={{ margin: '0 0 6px', fontSize: '15px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
            {feature.title}
          </h3>
          <p style={{ margin: '0 0 14px', fontSize: '13px', lineHeight: 1.5, color: 'hsl(var(--muted-foreground))' }}>
            {feature.description}
          </p>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {Object.entries(feature.layers).map(([layer, path]) => {
              const meta = LAYER_META[layer] || { label: layer, color: '#666' };
              return (
                <a
                  key={layer}
                  href={`${GITHUB_BASE}/${path}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '5px',
                    padding: '4px 10px',
                    borderRadius: '6px',
                    fontSize: '12px',
                    fontWeight: 500,
                    color: meta.color,
                    border: `1px solid ${meta.color}33`,
                    backgroundColor: `${meta.color}0d`,
                    textDecoration: 'none',
                    transition: 'opacity 0.15s',
                  }}
                  onMouseEnter={(e) => { (e.target as HTMLElement).style.opacity = '0.75'; }}
                  onMouseLeave={(e) => { (e.target as HTMLElement).style.opacity = '1'; }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                  {meta.label}
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
