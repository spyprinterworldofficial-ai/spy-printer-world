import type { ReactNode } from 'react';
import Shell from './Shell';
import { SITE } from './info';

export function PolicyPage({ title, children, active }: { title: string; children: ReactNode; active?: string }) {
  return (
    <Shell active={active}>
      <div className="container py-5 policy" style={{ maxWidth: 820 }}>
        <h1 className="fw-bold mb-1">{title}</h1>
        <p className="text-secondary small">Last updated: {SITE.updated}</p>
        {children}
      </div>
    </Shell>
  );
}
