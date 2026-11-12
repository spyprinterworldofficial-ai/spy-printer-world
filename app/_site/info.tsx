import type { ReactNode } from 'react';
// ✏️  Fill in the CONTACT details below before deploying (Razorpay checks them). Everything else can stay.
export const SITE = {
  business: {
    name: 'S.py — Printer World',
    address: 'NIT Raipur, G. E. Road, Amanaka, Raipur, Chhattisgarh - 492010',
    email: 'spy.printerworld.official@gmail.com',
    phone: 'FILL: +91 9354080166',
    jurisdiction: 'Raipur, Chhattisgarh',
  },
  updated: '12 November 2026',
  nav: [['/', 'Home'], ['/contact', 'Contact']] as [string, string][],
  softwareSite: 'https://spy-printer-world-software.vercel.app',
  // Live printers (each opens the student print page). Add new printers here.
  printers: [
    { name: 'NIT Raipur — Printer 1', place: 'NIT Raipur campus', url: 'Https://spy-printer-world.vercel.app/kiosk/00000000-0000-0000-0000-000000000001' },
    { name: 'NIT Raipur — Printer 2', place: 'NIT Raipur campus', url: 'https://spy-printer-world.vercel.app/kiosk/0ecb5b54-6495-4193-8ac4-4cfebd2fb4f3' },
  ],
  terms_scope: 'the S.py — Printer World self-service print kiosks and this website',
  service_description:
    'S.py — Printer World runs fully automatic, self-service printers on college campuses. Students scan the QR code on a printer, upload a document from their phone, pay online and collect the print — no shopkeeper, no queue. Optional AI study tools (cheat sheet, executive summary) and Eco-Ink toner saving are available on supported printers.',
  pricing_terms:
    'Black & white printing is charged per page, double-sided printing per sheet, and AI tools at the flat price shown on the printer page.',
  extra_terms: null as ReactNode,
  extra_privacy: null as ReactNode,
  extra_refunds: null as ReactNode,
  extra_shipping: null as ReactNode,
};
