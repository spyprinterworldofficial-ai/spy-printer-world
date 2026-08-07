import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

// Server-only client using the service role key so it can update
// print_jobs regardless of row-level security policies. NEVER expose
// SUPABASE_SERVICE_ROLE_KEY to the browser / NEXT_PUBLIC_ env vars.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = await req.json();

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    }

    // Match on the order id (already stamped onto the jobs when the order
    // was created) rather than trusting job_ids from the client. Only touch
    // rows still PENDING — if the webhook already marked them PAID, this is
    // a harmless no-op, which keeps the two paths idempotent.
    const { error } = await supabaseAdmin
      .from('print_jobs')
      .update({
        status: 'PAID',
        razorpay_payment_id,
      })
      .eq('razorpay_order_id', razorpay_order_id)
      .eq('status', 'PENDING');

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Payment verification failed:', err);
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 });
  }
}