import { SITE } from './info';

export default function PrinterLinks() {
  return (
    <div className="row g-3">
      {SITE.printers.map((p) => (
        <div className="col-md-6" key={p.url}>
          <a href={p.url} className="site-card p-3 d-flex align-items-center gap-3 text-decoration-none text-light h-100">
            <i className="bi bi-printer-fill fs-3 text-info"></i>
            <span className="flex-grow-1 text-break">
              <span className="d-block fw-semibold">{p.name}</span>
              <span className="d-block small text-secondary">{p.place}</span>
              <span className="d-block small text-info">{p.url}</span>
            </span>
            <i className="bi bi-box-arrow-up-right text-secondary"></i>
          </a>
        </div>
      ))}
    </div>
  );
}
