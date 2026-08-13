import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from '../db/supabaseAdmin.js';

const router = Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }

  const { data: admin, error } = await supabase
    .from('admin_users')
    .select('id, username, password_hash')
    .eq('username', username)
    .single();

  // Deliberately vague error either way — don't reveal whether the
  // username exists or the password was wrong.
  if (error || !admin) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const valid = await bcrypt.compare(password, admin.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = jwt.sign(
    { adminId: admin.id, username: admin.username },
    process.env.JWT_SECRET,
    { expiresIn: '30d' } // long-lived — this is a single-purpose admin app on your own phone
  );

  res.json({ token, username: admin.username });
});

export default router;