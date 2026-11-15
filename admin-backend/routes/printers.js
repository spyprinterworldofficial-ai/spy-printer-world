import { Router } from 'express';
import { supabase } from '../db/supabaseAdmin.js';
import { printerAccessParam } from '../middleware/access.js';

const router = Router();

// Every route below takes :id, so no route can skip the "may this user operate this printer?" check.
router.param('id', printerAccessParam);

const CARTRIDGE_DUTY_CYCLE = Number(process.env.CARTRIDGE_DUTY_CYCLE || 10000);

// GET /printers/:id/status
router.get('/:id/status', async (req, res) => {
  const { data: printer, error } = await supabase
    .from('printers')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // Page counts are summed in the database (admin_printer_pages): reading the jobs and adding them up
  // here stopped at 1,000 jobs (Supabase's per-request row limit). "Today" is Indian time.
  const { data: pages, error: pagesError } = await supabase.rpc('admin_printer_pages', { p_printer: req.params.id, p_days: 1 });
  if (pagesError) return res.status(500).json({ error: pagesError.message });
  const totalPagesPrinted = Number(pages.total_pages);
  const printsToday = Number(pages.prints_today);
  const pagesToday = Number(pages.pages_today);

  res.json({
    printer,
    totalPagesPrinted,
    printsToday,
    pagesToday,
    cartridgeDutyCycle: CARTRIDGE_DUTY_CYCLE,
    cartridgePercentUsed: Math.round((printer.cartridge_page_count / CARTRIDGE_DUTY_CYCLE) * 100),
  });
});

// GET /printers/:id/history?days=30 — prints per day (Indian dates), for the history drill-down
router.get('/:id/history', async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 366);
  const { data, error } = await supabase.rpc('admin_printer_pages', { p_printer: req.params.id, p_days: days });
  if (error) return res.status(500).json({ error: error.message });
  res.json((data.history || []).map((d) => ({ date: d.date, prints: Number(d.prints), pages: Number(d.pages) })));
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

