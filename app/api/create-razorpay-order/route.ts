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
    const { amount, job_ids } = await req.json(); // amount in rupees

    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
    }
    if (!Array.isArray(job_ids) || job_ids.length === 0) {
      return NextResponse.json({ error: 'Missing job_ids' }, { status: 400 });
    }

    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID!,
      key_secret: process.env.RAZORPAY_KEY_SECRET!,
    });

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100), // Razorpay expects paise
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