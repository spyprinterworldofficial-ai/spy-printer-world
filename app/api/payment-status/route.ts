import { NextResponse } from 'next/server';
import Razorpay from 'razorpay';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// The kiosk calls this when a student comes back to the page after paying (e.g. the phone reloaded the tab while the
// UPI app was open, so the normal "verify" step never ran). It asks Razorpay directly whether the order was paid, so it
// works even if the webhook is late or missing. Safe to call by anyone: it only marks jobs PAID if Razorpay says so.
export async function POST(req: Request) {
  try {
    const { order_id } = await req.json();
    if (typeof order_id !== 'string' || !/^order_[A-Za-z0-9]{6,40}$/.test(order_id)) {
      return NextResponse.json({ error: 'Bad order id' }, { status: 400 });
    }
    const { data: jobs, error } = await supabaseAdmin.from('print_jobs').select('id, status').eq('razorpay_order_id', order_id);
    if (error) throw error;
    if (!jobs?.length) return NextResponse.json({ state: 'unknown' });
    if (jobs.some((j) => ['PAID', 'PRINTING', 'COMPLETED'].includes(j.status))) return NextResponse.json({ state: 'paid' });

    const rzp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID!, key_secret: process.env.RAZORPAY_KEY_SECRET! });
    const order = await rzp.orders.fetch(order_id);
    const { items } = await rzp.orders.fetchPayments(order_id);
    const captured = items.find((p: any) => p.status === 'captured' && Number(p.amount) === Number(order.amount));
    if (captured) {
      const { error: e2 } = await supabaseAdmin
        .from('print_jobs')
        .update({ status: 'PAID', razorpay_payment_id: captured.id })
        .eq('razorpay_order_id', order_id)
        .eq('status', 'PENDING');
      if (e2) throw e2;
      console.log(`payment-status: recovered order ${order_id} (${captured.id})`);
      return NextResponse.json({ state: 'paid' });
    }
    // UPI can sit in "authorized/created" for a short while before it is captured.
    if (items.some((p: any) => ['created', 'authorized'].includes(p.status))) return NextResponse.json({ state: 'processing' });
    return NextResponse.json({ state: 'unpaid' });
  } catch (err) {
    console.error('payment-status failed:', err);
    return NextResponse.json({ error: 'Could not check payment' }, { status: 500 });
  }
}