import { NextResponse } from 'next/server';
import Razorpay from 'razorpay';
import { createClient } from '@supabase/supabase-js';

// Server-only client — service role key bypasses RLS, which this route
// needs to read/update any job regardless of who created it. Never expose
// this key or this client to the browser.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Fallback ONLY — used if a job's printer row somehow lacks pricing
// columns (shouldn't happen once the migration's run, but avoids a crash
// either way). Real pricing always comes from that specific printer's own
// row — different printers/institutes can charge different rates.
const FALLBACK_COST_PER_PAGE = 5;
const FALLBACK_BLANK_COST_PER_PAGE = 1.5;
const FALLBACK_DUPLEX_COST_PER_SHEET = 4.5;

// Shared formula — must stay byte-for-byte identical to computeItemAmount()
// in page.tsx and compute_amount() in the Pi's print_worker.py. A duplex
// job prices in pairs: one discounted sheet covers 2 pages. A leftover odd
// page can't be duplexed (nothing to print on its back), so it's charged
// at the plain single-side rate.
function computeJobAmount(
  pagesCount: number,
  copies: number,
  fileType: string,
  duplex: boolean,
  costPerPage: number,
  duplexCostPerSheet: number,
  blankCostPerPage: number
): number {
  const n = pagesCount * copies;
  if (fileType === 'BLANK') return n * blankCostPerPage;
  if (duplex) {
    const pairs = Math.floor(n / 2);
    const leftover = n % 2;
    return pairs * duplexCostPerSheet + leftover * costPerPage;
  }
  return n * costPerPage;
}

export async function POST(req: Request) {
  try {
    const { job_ids } = await req.json();

    if (!Array.isArray(job_ids) || job_ids.length === 0) {
      return NextResponse.json({ error: 'Missing job_ids' }, { status: 400 });
    }

    // The charge is computed here, from the database, never trusting
    // whatever the browser sends — a client could otherwise edit page
    // counts / amounts in JS before this call and pay less than the real
    // total. Only PENDING rows are trusted as "final" (COUNTING/
    // COUNT_FAILED rows haven't settled on a real page count yet).
    const { data: jobs, error: fetchError } = await supabaseAdmin
      .from('print_jobs')
      .select('id, pages_count, copies, status, file_type, duplex, printer_id')
      .in('id', job_ids);
    if (fetchError) throw fetchError;

    if (!jobs || jobs.length !== job_ids.length) {
      return NextResponse.json({ error: 'One or more jobs not found' }, { status: 400 });
    }
    const notReady = jobs.find((j) => j.status !== 'PENDING');
    if (notReady) {
      return NextResponse.json({ error: `Job ${notReady.id} is not ready for payment (status: ${notReady.status})` }, { status: 400 });
    }

    // All jobs in one order come from the same kiosk session, so they
    // should all share the same printer_id — but fetch pricing per-job's
    // actual printer_id anyway rather than assuming, in case that ever
    // changes. Cache lookups so we don't re-query the same printer twice.
    const printerPricingCache = new Map<string, { costPerPage: number; duplexCostPerSheet: number; blankCostPerPage: number }>();
    const getPrinterPricing = async (printerId: string) => {
      if (printerPricingCache.has(printerId)) return printerPricingCache.get(printerId)!;
      const { data: printer } = await supabaseAdmin
        .from('printers')
        .select('cost_per_page, duplex_cost_per_sheet, blank_cost_per_page')
        .eq('id', printerId)
        .single();
      const pricing = {
        costPerPage: printer?.cost_per_page ?? FALLBACK_COST_PER_PAGE,
        duplexCostPerSheet: printer?.duplex_cost_per_sheet ?? FALLBACK_DUPLEX_COST_PER_SHEET,
        blankCostPerPage: printer?.blank_cost_per_page ?? FALLBACK_BLANK_COST_PER_PAGE,
      };
      printerPricingCache.set(printerId, pricing);
      return pricing;
    };

    let amountRupees = 0;
    for (const j of jobs) {
      const pricing = await getPrinterPricing(j.printer_id);
      amountRupees += computeJobAmount(
        j.pages_count,
        j.copies || 1,
        j.file_type,
        !!j.duplex,
        pricing.costPerPage,
        pricing.duplexCostPerSheet,
        pricing.blankCostPerPage
      );
    }

    if (amountRupees <= 0) {
      return NextResponse.json({ error: 'Computed amount is zero' }, { status: 400 });
    }

    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID!,
      key_secret: process.env.RAZORPAY_KEY_SECRET!,
    });

    const order = await razorpay.orders.create({
      amount: Math.round(amountRupees * 100), // Razorpay expects paise
      currency: 'INR',
      receipt: `receipt_${Date.now()}`,
    });

    // Tag the pending jobs with this order id now, before payment happens.
    // This is what lets the webhook (which only knows the order id) find
    // and update the right rows later, even if the browser never calls
    // the verify endpoint.
    const { error: tagError } = await supabaseAdmin
      .from('print_jobs')
      .update({ razorpay_order_id: order.id })
      .in('id', job_ids)
      .eq('status', 'PENDING');
    if (tagError) throw tagError;

    return NextResponse.json({ order_id: order.id, amount: order.amount });
  } catch (err) {
    console.error('Razorpay order creation failed:', err);
    return NextResponse.json({ error: 'Failed to create order' }, { status: 500 });
  }
}