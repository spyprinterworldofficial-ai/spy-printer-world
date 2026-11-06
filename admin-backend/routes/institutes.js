import { Router } from 'express';
import { supabase } from '../db/supabaseAdmin.js';
import { accessiblePrinterIds, visibleInstituteIds } from '../middleware/access.js';

const router = Router();

// GET /institutes?search=nit&state=Chhattisgarh&sort=alpha
// Super admins see everything; vendors only the institutes that contain a printer assigned to them.
router.get('/', async (req, res) => {
  try {
    const { search, state, sort } = req.query;
    const visible = await visibleInstituteIds(req.admin);
    if (visible && visible.length === 0) return res.json([]);

    let query = supabase.from('institutes').select('id, name, state');
    if (visible) query = query.in('id', visible);
    if (search) query = query.ilike('name', `%${search}%`);
    if (state) query = query.eq('state', state);

    query = sort === 'alpha' || !sort
      ? query.order('name', { ascending: true })
      : query.order('created_at', { ascending: false });

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    console.error('[institutes]', err.message);
    res.status(503).json({ error: 'Temporary problem. Please try again.' });
  }
});

// GET /institutes/states — distinct list to populate the state filter dropdown
router.get('/states', async (req, res) => {
  try {
    const visible = await visibleInstituteIds(req.admin);
    if (visible && visible.length === 0) return res.json([]);

    let query = supabase.from('institutes').select('state');
    if (visible) query = query.in('id', visible);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json([...new Set(data.map((r) => r.state))].sort());
  } catch (err) {
    console.error('[institutes/states]', err.message);
    res.status(503).json({ error: 'Temporary problem. Please try again.' });
  }
});

// GET /institutes/:id/printers — only the printers this user may operate
router.get('/:id/printers', async (req, res) => {
  try {
    const allowed = await accessiblePrinterIds(req.admin);
    if (allowed && allowed.length === 0) return res.json([]);

    let query = supabase
      .from('printers')
      .select('id, name, is_enabled, paper_remaining, pi_internet_online, pi_printer_connected, last_heartbeat')
      .eq('institute_id', req.params.id)
      .order('name', { ascending: true });
    if (allowed) query = query.in('id', allowed);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    console.error('[institutes/printers]', err.message);
    res.status(503).json({ error: 'Temporary problem. Please try again.' });
  }
});

export default router;