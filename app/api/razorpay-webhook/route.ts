import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Configure this exact URL as a webhook in the Razorpay dashboard
// (Settings → Webhooks), subscribed to the "payment.captured" event,
// with a webhook secret set in RAZORPAY_WEBHOOK_SECRET below.
// This is a DIFFERENT secret from RAZORPAY_KEY_SECRET.

export async function POST(req: Request) {
  // Must read the raw body (not req.json()) because the signature is
  // computed over the exact raw bytes Razorpay sent.
  const rawBody = await req.text();
  const signature = req.headers.get('x-razorpay-signature');

  if (!signature) {
    return NextResponse.json({ error: 'Missing signature header' }, { status: 400 });
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!)
    .update(rawBody)
    .digest('hex');

  if (expectedSignature !== signature) {
    console.error('Webhook signature mismatch — rejecting');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  const event = JSON.parse(rawBody);

  try {
    if (event.event === 'payment.captured') {
      const payment = event.payload.payment.entity;
      const orderId = payment.order_id as string;
      const paymentId = payment.id as string;

      // Only flips rows still PENDING — if the browser's own verify call
      // already marked them PAID, this is a no-op. Keeps both paths safe
      // to run in either order or both.
      const { error, count } = await supabaseAdmin
        .from('print_jobs')
        .update({ status: 'PAID', razorpay_payment_id: paymentId }, { count: 'exact' })
        .eq('razorpay_order_id', orderId)
        .eq('status', 'PENDING');

      if (error) throw error;
      console.log(`Webhook: reconciled ${count ?? 0} job(s) for order ${orderId}`);
    }

    // Always 200 on anything we successfully parsed and checked, even
    // events we don't act on — Razorpay retries on non-2xx responses.
    return NextResponse.json({ received: true });
  } catch (err) {
    console.error('Webhook processing failed:', err);
    // Still return 200 here would hide real failures from Razorpay's
    // retry mechanism, so surface a 500 to get a retry.
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
  }
}