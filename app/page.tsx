import Shell from './_site/Shell';
import Flow from './_site/Flow';
import PrinterLinks from './_site/PrinterLinks';
import { SITE } from './_site/info';

export const metadata = { title: 'S.py — Printer World | Automatic campus printing', description: 'Scan, upload, pay and print — self-service printers for college campuses.' };

const FEATURES = [
  ['bi-lightning-charge-fill text-warning', 'Quick and reliable', 'Upload from your phone and collect the print in moments — no queue, no shopkeeper.'],
  ['bi-trash3-fill text-info', 'Auto deletion of files', 'Files are deleted automatically after printing; unpaid uploads within 24 hours.'],
  ['bi-shield-check text-success', 'Safe by design', 'Every file is safety-checked before printing, and you only pay for pages that will print.'],
  ['bi-stars text-warning', 'AI study tools', 'Optional one-page cheat sheets and executive summaries on supported printers.'],
  ['bi-recycle text-success', 'Eco-Ink', 'Dark slides are printed with less toner, and double-sided printing costs less.'],
  ['bi-credit-card-2-front-fill text-info', 'Secure payments', 'Pay by UPI, card or net banking through Razorpay.'],
];

export default function Home() {
  return (
    <Shell active="/">
      <section className="container py-5">
        <div className="row align-items-center g-4 g-lg-5">
          <div className="col-lg-7">
            <h1 className="display-5 fw-bold">Campus printing, <span className="site-grad">fully automatic.</span></h1>
            <p className="lead text-secondary mt-3">
              S.py — Printer World installs self-service printers in colleges and hostels. Scan the QR code on the printer,
              upload your document from your phone, pay online and collect your print — any time, without waiting for anyone.
            </p>
            <div className="mt-4"><Flow /></div>
          </div>
          <div className="col-lg-5">
            <div className="site-card p-4">
              <h2 className="h5 fw-bold mb-3">Pricing</h2>
              <ul className="list-unstyled mb-0 d-flex flex-column gap-2">
                <li><i className="bi bi-check2 text-success me-2"></i>Black &amp; white printing, charged per page</li>
                <li><i className="bi bi-check2 text-success me-2"></i>Double-sided printing at a lower per-sheet price</li>
                <li><i className="bi bi-check2 text-success me-2"></i>AI cheat sheet / executive summary at a flat price</li>
                <li><i className="bi bi-check2 text-success me-2"></i>The exact amount is always shown before you pay</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="container py-4">
        <h2 className="h3 fw-bold mb-3">Our printers</h2>
        <p className="text-secondary">Each printer has its own page — the same page its QR code opens.</p>
        <PrinterLinks />
      </section>

      <section className="container py-5">
        <h2 className="h3 fw-bold mb-4">At NIT Raipur</h2>
        <div className="row g-3 text-center">
          {[['Main Building', '1600+ prints'], ['Girls Hostel', '1000+ prints']].map(([place, count]) => (
            <div className="col-md-6" key={place}>
              <div className="site-card p-4 h-100">
                <div className="text-secondary">{place}</div>
                <div className="display-6 fw-bold site-grad">{count}</div>
                <div className="text-secondary">with almost no print failure</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="container py-4">
        <div className="row g-3">
          {FEATURES.map(([icon, title, text]) => (
            <div className="col-md-6 col-lg-4" key={title}>
              <div className="site-card p-4 h-100">
                <i className={`bi ${icon} fs-3`}></i>
                <h3 className="h6 fw-bold mt-2">{title}</h3>
                <p className="small text-secondary mb-0">{text}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="container py-5">
        <div className="site-card p-4 d-md-flex align-items-center justify-content-between gap-3">
          <div>
            <h2 className="h5 fw-bold mb-1">Run a printing shop?</h2>
            <p className="text-secondary mb-md-0">Get the same automatic printing on your own Windows computer and printer — no extra hardware.</p>
          </div>
          <a href={SITE.softwareSite} className="btn btn-brand px-4">S.py for shops →</a>
        </div>
      </section>
    </Shell>
  );
}
