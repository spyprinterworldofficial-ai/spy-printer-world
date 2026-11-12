import Link from 'next/link';
import { PolicyPage } from './Policy';
import { SITE } from './info';

const B = SITE.business;
const Contact = () => (
  <p>Questions? Email <a href={`mailto:${B.email}`}>{B.email}</a> or call <a href={`tel:${B.phone.replace(/\s/g, '')}`}>{B.phone}</a>.</p>
);

export function Terms() {
  return (
    <PolicyPage title="Terms & Conditions">
      <p>These terms apply to {SITE.terms_scope} operated by {B.name} (&quot;we&quot;, &quot;us&quot;). By uploading a file or making a payment you agree to them.</p>
      <h2>1. The service</h2>
      <p>{SITE.service_description}</p>
      <h2>2. Prices and payment</h2>
      <p>{SITE.pricing_terms} The exact amount is always shown before you pay. Online payments are processed by Razorpay; we never see or store your card, UPI or bank details.</p>
      <h2>3. Your files</h2>
      <ul>
        <li>Only upload documents you have the right to print. Do not upload illegal, obscene or copyright-infringing material.</li>
        <li>Every file is automatically checked for safety before printing. Files that could damage the printer or waste paper/toner are rejected and you are not charged.</li>
        <li>Files are deleted automatically after printing, and unpaid uploads are deleted within 24 hours.</li>
      </ul>
      <h2>4. Collecting prints</h2>
      <p>Prints come out at the printer you chose right after payment. Please collect them promptly; we are not responsible for prints left unattended.</p>
      {SITE.extra_terms}
      <h2>Limitation of liability</h2>
      <p>Our total liability for any print job is limited to the amount you paid for that job. We are not liable for indirect losses.</p>
      <h2>Governing law</h2>
      <p>These terms are governed by the laws of India. Disputes are subject to the courts of {B.jurisdiction}.</p>
      <Contact />
    </PolicyPage>
  );
}

export function Privacy() {
  return (
    <PolicyPage title="Privacy Policy">
      <p>{B.name} respects your privacy. This policy explains what we collect and why.</p>
      <h2>What we collect</h2>
      <ul>
        <li><b>Files you upload</b> — used only to print them. They are deleted automatically after printing, and any unpaid upload is deleted within 24 hours. We do not read, share or keep copies of your documents.</li>
        <li><b>Print job details</b> — file name, page count, options, amount and time, kept for accounting and to handle refunds.</li>
        <li><b>Payment details</b> — handled entirely by Razorpay. We receive only a payment reference and status, never your card, UPI or bank details.</li>
        {SITE.extra_privacy}
      </ul>
      <h2>What we don&apos;t do</h2>
      <p>We do not sell or rent personal data, and we do not use your documents for advertising or training.</p>
      <h2>Security</h2>
      <p>Files are stored privately and are reachable only through short-lived, single-use links. Every upload is safety-checked in an isolated process before it reaches a printer.</p>
      <h2>Your choices</h2>
      <p>You can remove a file before paying, and you can ask us to delete your job records at any time.</p>
      <Contact />
    </PolicyPage>
  );
}

export function Refunds() {
  return (
    <PolicyPage title="Refund & Cancellation Policy">
      <h2>Print jobs</h2>
      <ul>
        <li>If you paid and the print failed, did not come out, or came out incomplete because of a printer or system fault, you get a <b>full refund</b> for that job.</li>
        <li>Files rejected by the safety check are rejected <b>before</b> payment, so you are never charged for them.</li>
        <li>Prints that came out correctly as per the options you selected (pages, copies, colour, sides) are not refundable.</li>
        <li>To request a refund, contact us within 7 days with the payment time and amount (or the Razorpay payment ID from your receipt).</li>
        <li>Approved refunds are made to the original payment method within <b>5–7 working days</b>.</li>
      </ul>
      {SITE.extra_refunds}
      <h2>Cancellation</h2>
      <p>You can cancel at any time before paying by removing your files. Once payment is complete, printing starts automatically and the job cannot be cancelled.</p>
      <Contact />
    </PolicyPage>
  );
}

export function Shipping() {
  return (
    <PolicyPage title="Shipping & Delivery Policy">
      <p>We do not ship physical goods.</p>
      <ul>
        <li><b>Prints</b> are delivered on the spot: they come out of the printer you chose within moments of payment and are collected by you at that printer.</li>
        {SITE.extra_shipping}
      </ul>
      <Contact />
    </PolicyPage>
  );
}

export function ContactPage({ plan }: { plan?: string }) {
  return (
    <PolicyPage title="Contact Us" active="/contact">
      {plan && (
        <div className="alert alert-info mt-3">
          You chose the <b>{plan}-month</b> plan. Contact us by phone or email below and we&apos;ll set up your printer and
          send your payment link. (Self-service online checkout is coming soon.)
        </div>
      )}
      <div className="site-card p-4 mt-3">
        <p className="mb-2"><i className="bi bi-building me-2 text-info"></i><b>{B.name}</b></p>
        <p className="mb-2"><i className="bi bi-geo-alt-fill me-2 text-info"></i>{B.address}</p>
        <p className="mb-2"><i className="bi bi-envelope-fill me-2 text-info"></i><a href={`mailto:${B.email}`}>{B.email}</a></p>
        <p className="mb-0"><i className="bi bi-telephone-fill me-2 text-info"></i><a href={`tel:${B.phone.replace(/\s/g, '')}`}>{B.phone}</a></p>
      </div>
      <p className="mt-3">For a refund or a problem with a print, please include the time of the job and the amount paid. We reply within 1 working day.</p>
      <p>See also: <Link href="/refunds">Refund &amp; Cancellation Policy</Link>.</p>
    </PolicyPage>
  );
}
