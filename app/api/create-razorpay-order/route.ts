import { NextResponse } from 'next/server';
import Razorpay from 'razorpay';
import { createClient } from '@supabase/supabase-js';
import { computeJobAmount, pricingFromPrinter, type PricingConfig } from '@/lib/pricing';

// Service-role client: server only, never exposed to the browser.
const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function POST(req: Request) {
  try {
    const { job_ids } = await req.json();
    if (!Array.isArray(job_ids) || job_ids.length === 0) {
      return NextResponse.json({ error: 'Missing job_ids' }, { status: 400 });
    }

    // The charge is always recomputed here from the database — never from anything the browser sends.
    const { data: jobs, error: fetchError } = await supabaseAdmin
      .from('print_jobs')
      .select('id, pages_count, copies, status, file_type, duplex, printer_id, ai_mode, green_ai, ai_pdf_path, inspected_at')
      .in('id', job_ids);
    if (fetchError) throw fetchError;

    if (!jobs || jobs.length !== job_ids.length) {
      return NextResponse.json({ error: 'One or more jobs not found' }, { status: 400 });
    }
    const notReady = jobs.find((j) => j.status !== 'PENDING');
    if (notReady) {
      return NextResponse.json({ error: `Job ${notReady.id} is not ready for payment (status: ${notReady.status})` }, { status: 400 });
    }
    // Never take money for AI output the printer hasn't actually produced.
    // Nothing is sold until the Pi has inspected the file and rebuilt it as a clean PDF.
    const uninspected = jobs.find((j) => j.file_type !== 'BLANK' && !j.inspected_at);
    if (uninspected) {
      return NextResponse.json({ error: 'A file has not been checked yet. Please remove it and upload it again.' }, { status: 400 });
    }

    const missingAi = jobs.find((j) => (j.ai_mode || j.green_ai) && !j.ai_pdf_path);
    if (missingAi) {
      return NextResponse.json({ error: `AI output for job ${missingAi.id} isn't ready yet` }, { status: 400 });
    }

    const pricingCache = new Map<string, PricingConfig>();
    const pricingFor = async (printerId: string) => {
      if (!pricingCache.has(printerId)) {
        const { data } = await supabaseAdmin
          .from('printers')
          .select('cost_per_page, duplex_cost_per_sheet, blank_cost_per_page, green_ai_fee, cheatsheet_price, execsum_price')
          .eq('id', printerId)
          .single();
        pricingCache.set(printerId, pricingFromPrinter(data));
      }
      return pricingCache.get(printerId)!;
    };

    let amountRupees = 0;
    for (const j of jobs) {
      amountRupees += computeJobAmount(
        {
          pages: j.pages_count,
          copies: j.copies || 1,
          fileType: j.file_type,
          duplex: !!j.duplex,
          aiMode: j.ai_mode,
          greenApplied: !!j.green_ai,
        },
        await pricingFor(j.printer_id)
      );
    }
    if (amountRupees <= 0) {
      return NextResponse.json({ error: 'Computed amount is zero' }, { status: 400 });
    }

    const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID!, key_secret: process.env.RAZORPAY_KEY_SECRET! });
    const order = await razorpay.orders.create({
      amount: Math.round(amountRupees * 100), // paise
      currency: 'INR',
      receipt: `receipt_${Date.now()}`,
    });

    // Tag the jobs with the order id now so the webhook can find them even if the browser never calls verify.
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