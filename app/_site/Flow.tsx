const STEPS = [
  ['bi-qr-code-scan', 'Scan', 'linear-gradient(135deg,#36d1dc,#5b86e5)'],
  ['bi-cloud-arrow-up-fill', 'Upload', 'linear-gradient(135deg,#f7971e,#ffd200)'],
  ['bi-credit-card-fill', 'Pay', 'linear-gradient(135deg,#11998e,#38ef7d)'],
  ['bi-printer-fill', 'Print', 'linear-gradient(135deg,#ff5f6d,#c31432)'],
];

export default function Flow() {
  return (
    <div className="d-flex align-items-center gap-2 gap-md-3 flex-wrap">
      {STEPS.map(([icon, label, bg], i) => (
        <div key={label} className="d-flex align-items-center gap-2 gap-md-3">
          <div className="text-center">
            <div className="flow-step mx-auto" style={{ background: bg }}><i className={`bi ${icon}`}></i></div>
            <div className="small fw-semibold mt-1">{label}</div>
          </div>
          {i < STEPS.length - 1 && <i className="bi bi-arrow-right text-secondary fs-5"></i>}
        </div>
      ))}
    </div>
  );
}
