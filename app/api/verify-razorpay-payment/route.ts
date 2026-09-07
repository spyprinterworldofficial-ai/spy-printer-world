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

// Server-side pricing config — NOT NEXT_PUBLIC, since this route doesn't
// need it baked into the browser bundle. Must be kept in sync with the
// NEXT_PUBLIC_* equivalents in page.tsx (what's displayed) and the
// matching vars in the Pi worker's .env (used right when a PPT/DOC
// finishes counting) — three separate places since each runs in a
// different environment, but all read from an actual env var instead of a
// hardcoded literal, so a config change can't silently fail to apply.
const COST_PER_PAGE = Number(process.env.COST_PER_PAGE) || 3;
const BLANK_COST_PER_PAGE = Number(process.env.BLANK_COST_PER_PAGE) || 1.5;
const DUPLEX_COST_PER_SHEET = Number(process.env.DUPLEX_COST_PER_SHEET) || 4.5;

// Shared formula — must stay byte-for-byte identical to computeItemAmount()
// in page.tsx and compute_amount() in the Pi's print_worker.py. A duplex
// job prices in pairs: one discounted sheet covers 2 pages. A leftover odd
// page can't be duplexed (nothing to print on its back), so it's charged
// at the plain single-side rate.
function computeJobAmount(pagesCount: number, copies: number, fileType: string, duplex: boolean): number {
  const n = pagesCount * copies;
  if (fileType === 'BLANK') return n * BLANK_COST_PER_PAGE;
  if (duplex) {
    const pairs = Math.floor(n / 2);
    const leftover = n % 2;
    return pairs * DUPLEX_COST_PER_SHEET + leftover * COST_PER_PAGE;
  }
  return n * COST_PER_PAGE;
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
      .select('id, pages_count, copies, status, file_type, duplex')
      .in('id', job_ids);
    if (fetchError) throw fetchError;

    if (!jobs || jobs.length !== job_ids.length) {
      return NextResponse.json({ error: 'One or more jobs not found' }, { status: 400 });
    }
    const notReady = jobs.find((j) => j.status !== 'PENDING');
    if (notReady) {
      return NextResponse.json({ error: `Job ${notReady.id} is not ready for payment (status: ${notReady.status})` }, { status: 400 });
    }

    const amountRupees = jobs.reduce(
      (sum, j) => sum + computeJobAmount(j.pages_count, j.copies || 1, j.file_type, !!j.duplex),
      0
    );

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