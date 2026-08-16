import { Router } from 'express';
import { supabase } from '../db/supabaseAdmin.js';

const router = Router();

// POST /devices  { expoPushToken }  — called once after login on the phone
router.post('/', async (req, res) => {
  const { expoPushToken } = req.body || {};
  if (!expoPushToken) return res.status(400).json({ error: 'expoPushToken required' });

  const { error } = await supabase
    .from('admin_device_tokens')
    .upsert(
      { admin_user_id: req.admin.adminId, expo_push_token: expoPushToken },
      { onConflict: 'expo_push_token' }
    );
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

export default router;