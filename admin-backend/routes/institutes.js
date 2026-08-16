import { Router } from 'express';
import { supabase } from '../db/supabaseAdmin.js';

const router = Router();

// GET /institutes?search=nit&state=Chhattisgarh&sort=alpha
router.get('/', async (req, res) => {
  const { search, state, sort } = req.query;

  let query = supabase.from('institutes').select('id, name, state');

  if (search) {
    query = query.ilike('name', `%${search}%`);
  }
  if (state) {
    query = query.eq('state', state);
  }

  query = sort === 'alpha' || !sort
    ? query.order('name', { ascending: true })
    : query.order('created_at', { ascending: false });

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /institutes/states — distinct list to populate the state filter dropdown
router.get('/states', async (_req, res) => {
  const { data, error } = await supabase.from('institutes').select('state');
  if (error) return res.status(500).json({ error: error.message });
  const states = [...new Set(data.map((r) => r.state))].sort();
  res.json(states);
});

// GET /institutes/:id/printers
router.get('/:id/printers', async (req, res) => {
  const { data, error } = await supabase
    .from('printers')
    .select('id, name, is_enabled, paper_remaining, pi_internet_online, pi_printer_connected')
    .eq('institute_id', req.params.id)
    .order('name', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

export default router;