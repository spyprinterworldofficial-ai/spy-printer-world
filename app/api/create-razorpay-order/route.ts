import { NextResponse } from 'next/server';
import Razorpay from 'razorpay';
import { createClient } from '@supabase/supabase-js';

// Service role client so this route can tag print_jobs with the order id
// regardless of RLS (the anon key only has INSERT rights on PENDING rows).
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  try {
    const { job_ids } = await req.json();

    if (!Array.isArray(job_ids) || job_ids.length === 0) {
      return NextResponse.json({ error: 'Missing job_ids' }, { status: 400 });
    }

    // The charge is computed here, from the database, not from whatever
    // the browser sends — a client could otherwise edit page counts /
    // amounts in JS before this call and pay less than the real total.
    // Only PENDING rows are trusted as "final" (COUNTING/COUNT_FAILED rows
    // haven't settled on a real page count yet).
    const { data: jobs, error: fetchError } = await supabaseAdmin
      .from('print_jobs')
      .select('id, pages_count, copies, status')
      .in('id', job_ids);
    if (fetchError) throw fetchError;

    if (!jobs || jobs.length !== job_ids.length) {
      return NextResponse.json({ error: 'One or more jobs not found' }, { status: 400 });
    }
    const notReady = jobs.find((j) => j.status !== 'PENDING');
    if (notReady) {
      return NextResponse.json({ error: `Job ${notReady.id} is not ready for payment (status: ${notReady.status})` }, { status: 400 });
    }

    const COST_PER_PAGE = 4; // must match the Pi worker's COST_PER_PAGE and the website's display constant
    const totalPages = jobs.reduce((sum, j) => sum + j.pages_count * (j.copies || 1), 0);
    const amountRupees = totalPages * COST_PER_PAGE;

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
    const { error } = await supabaseAdmin
      .from('print_jobs')
      .update({ razorpay_order_id: order.id })
      .in('id', job_ids)
      .eq('status', 'PENDING');
    if (error) throw error;

    return NextResponse.json({ order_id: order.id, amount: order.amount });
  } catch (err) {
    console.error('Razorpay order creation failed:', err);
    return NextResponse.json({ error: 'Failed to create order' }, { status: 500 });
  }
}