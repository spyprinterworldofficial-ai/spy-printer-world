import { Router } from 'express';
import { supabase } from '../db/supabaseAdmin.js';

const router = Router();

// GET /finance/:printerId/today — today's revenue + the list of paid orders
router.get('/:printerId/today', async (req, res) => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

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

// GET /finance/:printerId/total — lifetime total + monthly/weekly/yearly breakdown
router.get('/:printerId/total', async (req, res) => {
  const { data, error } = await supabase
    .from('print_jobs')
    .select('amount_paid, created_at')
    .eq('printer_id', req.params.printerId)
    .in('status', ['PAID', 'PRINTING', 'COMPLETED']);
  if (error) return res.status(500).json({ error: error.message });

  const totalRevenue = data.reduce((sum, j) => sum + Number(j.amount_paid), 0);

  const byMonth = {};
  const byWeek = {};
  const byYear = {};

  for (const job of data) {
    const d = new Date(job.created_at);
    const amount = Number(job.amount_paid);

    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    byMonth[monthKey] = (byMonth[monthKey] || 0) + amount;

    const yearKey = `${d.getFullYear()}`;
    byYear[yearKey] = (byYear[yearKey] || 0) + amount;

    // ISO week number, for a simple weekly bucket
    const weekDate = new Date(d);
    weekDate.setDate(weekDate.getDate() + 4 - (weekDate.getDay() || 7));
    const yearStart = new Date(weekDate.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((weekDate - yearStart) / 86400000 + 1) / 7);
    const weekKey = `${weekDate.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    byWeek[weekKey] = (byWeek[weekKey] || 0) + amount;
  }

  const toSortedArray = (obj) =>
    Object.entries(obj)
      .map(([period, revenue]) => ({ period, revenue }))
      .sort((a, b) => (a.period < b.period ? 1 : -1));

  res.json({
    totalRevenue,
    monthly: toSortedArray(byMonth),
    weekly: toSortedArray(byWeek),
    yearly: toSortedArray(byYear),
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