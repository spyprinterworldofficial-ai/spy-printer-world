import { ContactPage } from '../_site/policies';

export const metadata = { title: 'Contact Us | S.py — Printer World' };

export default function Page({ searchParams }: { searchParams: { plan?: string } }) {
  const plan = ['1', '2', '4', '6'].includes(searchParams.plan ?? '') ? searchParams.plan : undefined;
  return <ContactPage plan={plan} />;
}
