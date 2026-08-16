import { Router } from 'express';
import { supabase } from '../db/supabaseAdmin.js';

const router = Router();

const CARTRIDGE_DUTY_CYCLE = Number(process.env.CARTRIDGE_DUTY_CYCLE || 10000);

// GET /printers/:id/status
router.get('/:id/status', async (req, res) => {
  const { data: printer, error } = await supabase
    .from('printers')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // Lifetime total pages printed — summed from completed jobs, so this
  // stays accurate even across cartridge replacements (unlike
  // cartridge_page_count, which resets).
  const { data: completedJobs, error: jobsError } = await supabase
    .from('print_jobs')
    .select('pages_count, copies')
    .eq('printer_id', req.params.id)
    .eq('status', 'COMPLETED');
  if (jobsError) return res.status(500).json({ error: jobsError.message });

  const totalPagesPrinted = completedJobs.reduce(
    (sum, j) => sum + j.pages_count * (j.copies || 1), 0
  );

  // Today's print count, in the server's local date — good enough for a
  // single-timezone deployment (India). Uses created_at as a proxy for when
  // it was completed, which is fine at kiosk scale.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const { data: todayJobs, error: todayError } = await supabase
    .from('print_jobs')
    .select('pages_count, copies')
    .eq('printer_id', req.params.id)
    .eq('status', 'COMPLETED')
    .gte('created_at', startOfToday.toISOString());
  if (todayError) return res.status(500).json({ error: todayError.message });

  const printsToday = todayJobs.length;
  const pagesToday = todayJobs.reduce((sum, j) => sum + j.pages_count * (j.copies || 1), 0);

  res.json({
    printer,
    totalPagesPrinted,
    printsToday,
    pagesToday,
    cartridgeDutyCycle: CARTRIDGE_DUTY_CYCLE,
    cartridgePercentUsed: Math.round((printer.cartridge_page_count / CARTRIDGE_DUTY_CYCLE) * 100),
  });
});

// GET /printers/:id/history?days=30 — prints per day, for the history drill-down
router.get('/:id/history', async (req, res) => {
  const days = Number(req.query.days || 30);
  const since = new Date();
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('print_jobs')
    .select('created_at, pages_count, copies')
    .eq('printer_id', req.params.id)
    .eq('status', 'COMPLETED')
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  // Group by calendar date
  const byDate = {};
  for (const job of data) {
    const date = job.created_at.slice(0, 10); // YYYY-MM-DD
    if (!byDate[date]) byDate[date] = { date, prints: 0, pages: 0 };
    byDate[date].prints += 1;
    byDate[date].pages += job.pages_count * (job.copies || 1);
  }

  res.json(Object.values(byDate).sort((a, b) => (a.date < b.date ? 1 : -1)));
});

// PATCH /printers/:id/enable  { is_enabled: boolean }
router.patch('/:id/enable', async (req, res) => {
  const { is_enabled } = req.body || {};
  if (typeof is_enabled !== 'boolean') {
    return res.status(400).json({ error: 'is_enabled (boolean) required' });
  }
  const { error } = await supabase
    .from('printers')
    .update({ is_enabled })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// PATCH /printers/:id/paper  { paper_remaining: number }
// Used after physically refilling the tray.
router.patch('/:id/paper', async (req, res) => {
  const { paper_remaining } = req.body || {};
  if (typeof paper_remaining !== 'number' || paper_remaining < 0) {
    return res.status(400).json({ error: 'paper_remaining (non-negative number) required' });
  }
  const { error } = await supabase
    .from('printers')
    .update({ paper_remaining })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// POST /printers/:id/reset-cartridge
// Used after physically replacing the toner cartridge — resets the duty
// cycle counter without touching the lifetime totalPagesPrinted stat.
router.post('/:id/reset-cartridge', async (req, res) => {
  const { error } = await supabase
    .from('printers')
    .update({ cartridge_page_count: 0 })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  // Clear any open cartridge alert so the monitor doesn't immediately
  // re-fire before the next real check.
  await supabase
    .from('printer_alert_state')
    .update({ is_active: false })
    .eq('printer_id', req.params.id)
    .eq('alert_type', 'CARTRIDGE_NEAR_LIMIT');

  res.json({ success: true });
});

export default router;