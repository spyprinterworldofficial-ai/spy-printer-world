import { Router } from 'express';
import { supabase } from '../db/supabaseAdmin.js';
import { printerAccessParam } from '../middleware/access.js';
import { startOfTodayIST } from '../lib/ist.js';

const router = Router();

// Every route below takes :printerId; vendors only get the printers assigned to them.
router.param('printerId', printerAccessParam);

// GET /finance/:printerId/today — today's revenue + the list of paid orders
router.get('/:printerId/today', async (req, res) => {
  const startOfToday = startOfTodayIST();

  const { data, error } = await supabase
    .from('print_jobs')
    .select('id, file_name, amount_paid, razorpay_payment_id, created_at, status')
    .eq('printer_id', req.params.printerId)
    .in('status', ['PAID', 'PRINTING', 'COMPLETED'])
    .gte('created_at', startOfToday.toISOString())
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const totalRevenue = data.reduce((sum, j) => sum + Number(j.amount_paid), 0);

  res.json({
    totalRevenue,
    orderCount: data.length,
    orders: data.map((j) => ({
      id: j.id,
      fileName: j.file_name,
      amount: j.amount_paid,
      paymentRef: j.razorpay_payment_id,
      createdAt: j.created_at,
      status: j.status,
    })),
  });
});

// GET /finance/:printerId/total — lifetime total + monthly/weekly/yearly breakdown.
// Summed inside the database (admin_printer_finance): fetching rows and adding them up here stopped
// working past 1,000 paid jobs, because Supabase returns at most 1,000 rows per request.
router.get('/:printerId/total', async (req, res) => {
  const { data, error } = await supabase.rpc('admin_printer_finance', { p_printer: req.params.printerId });
  if (error) return res.status(500).json({ error: error.message });
  const rows = (list) => (list || []).map((r) => ({ period: r.period, revenue: Number(r.revenue) }));
  res.json({
    totalRevenue: Number(data.total),
    todayRevenue: Number(data.today),
    monthly: rows(data.monthly),
    weekly: rows(data.weekly),
    yearly: rows(data.yearly),
  });
});

// GET /finance/:printerId/history?page=1&pageSize=30 — full paginated payment log
router.get('/:printerId/history', async (req, res) => {
  const page = Number(req.query.page || 1);
  const pageSize = Number(req.query.pageSize || 30);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabase
    .from('print_jobs')
    .select('id, file_name, amount_paid, razorpay_payment_id, created_at, status, pages_count, copies', { count: 'exact' })
    .eq('printer_id', req.params.printerId)
    .in('status', ['PAID', 'PRINTING', 'COMPLETED'])
    .order('created_at', { ascending: false })
    .range(from, to);
  if (error) return res.status(500).json({ error: error.message });

  res.json({
    page,
    pageSize,
    total: count,
    orders: data.map((j) => ({
      id: j.id,
      fileName: j.file_name,
      amount: j.amount_paid,
      pages: j.pages_count * (j.copies || 1),
      paymentRef: j.razorpay_payment_id,
      createdAt: j.created_at,
      status: j.status,
    })),
  });
});

export default router;

