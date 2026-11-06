import { Router } from 'express';
import { supabase } from '../db/supabaseAdmin.js';

const router = Router();

// The admin app registers its Expo push token here so alerts can reach this phone.
router.post('/', async (req, res) => {
  const token = String(req.body?.expoPushToken || '').trim();
  if (!/^(Expo|Exponent)PushToken\[.+\]$/.test(token)) return res.status(400).json({ error: 'Invalid push token' });

  const { error } = await supabase
    .from('admin_device_tokens')
    .upsert({ expo_push_token: token, admin_user_id: req.admin.adminId }, { onConflict: 'expo_push_token' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

export default router;