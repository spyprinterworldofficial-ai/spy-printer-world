import type { ReactNode } from 'react';
import Link from 'next/link';
import { SITE } from './info';

/** Header + footer shared by the home page and the policy pages. */
export default function Shell({ children, active }: { children: ReactNode; active?: string }) {
  return (
    <div className="site min-vh-100 d-flex flex-column text-light">
      <header className="site-header border-bottom border-secondary">
        <div className="container d-flex flex-wrap align-items-center justify-content-between py-3 gap-2">
          <Link href="/" className="d-flex align-items-center gap-2 text-decoration-none text-light">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/spy-logo.png" alt="S.py logo" style={{ height: 44, width: 'auto' }} />
            <span className="lh-sm">
              <span className="d-block fw-bold">S.py — Printer World</span>
              <span className="d-block small text-secondary">Your Automatic Printer</span>
            </span>
          </Link>
          <nav className="d-flex flex-wrap gap-1">
            {SITE.nav.map(([href, label]) => (
              <Link key={href} href={href} className={`btn btn-sm ${active === href ? 'btn-info text-dark' : 'btn-outline-secondary text-light'}`}>
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className="flex-grow-1">{children}</main>

      <footer className="border-top border-secondary mt-5">
        <div className="container py-4 small text-secondary d-flex flex-column flex-md-row justify-content-between gap-3">
          <div>
            <div className="fw-semibold text-light">{SITE.business.name}</div>
            <div>{SITE.business.address}</div>
            <div>{SITE.business.email} · {SITE.business.phone}</div>
          </div>
          <div className="d-flex flex-wrap gap-3 align-items-start">
            <Link href="/terms" className="link-secondary">Terms &amp; Conditions</Link>
            <Link href="/privacy" className="link-secondary">Privacy Policy</Link>
            <Link href="/refunds" className="link-secondary">Refund &amp; Cancellation</Link>
            <Link href="/shipping" className="link-secondary">Shipping &amp; Delivery</Link>
            <Link href="/contact" className="link-secondary">Contact Us</Link>
          </div>
        </div>
        <div className="container pb-4 small text-secondary">
          © {new Date().getFullYear()} {SITE.business.name}. Payments are processed securely by Razorpay.
        </div>
      </footer>
      <style>{`
        .site { background: radial-gradient(circle at 50% 0%, #172029 0%, #0a0e12 60%); }
        .site-header { background: rgba(10,14,18,.6); backdrop-filter: blur(6px); position: sticky; top: 0; z-index: 10; }
        .site-card { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 14px; }
        .site-grad { background: linear-gradient(135deg,#36d1dc,#5b86e5); -webkit-background-clip: text; background-clip: text; color: transparent; }
        .btn-brand { background: linear-gradient(135deg,#36d1dc,#5b86e5); border: none; color: #041019; font-weight: 700; }
        .btn-brand:hover { filter: brightness(1.08); color: #041019; }
        .flow-step { width: 64px; height: 64px; border-radius: 16px; display: grid; place-items: center; font-size: 1.6rem; color: #fff; }
        .policy h2 { font-size: 1.15rem; margin-top: 1.75rem; color: #e2e8f0; }
        .policy p, .policy li { color: #cbd5e1; }
        .strike { text-decoration: line-through; color: #94a3b8; }
      `}</style>
    </div>
  );
}
