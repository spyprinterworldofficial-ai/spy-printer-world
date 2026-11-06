import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from '../db/supabaseAdmin.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Small in-memory brake on password guessing (single Render instance; resets on restart).
const MAX_FAILURES = 8;
const WINDOW_MS = 15 * 60 * 1000;
const failures = new Map();
const attemptKey = (req, username) => `${req.ip}|${String(username).toLowerCase()}`;
const isLimited = (key) => {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW_MS) {
    failures.delete(key);
    return false;
  }
  return f.count >= MAX_FAILURES;
};
const recordFailure = (key) => {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > WINDOW_MS) failures.set(key, { count: 1, first: Date.now() });
  else f.count += 1;
};

const signToken = (user) =>
  jwt.sign({ adminId: user.id, username: user.username, v: user.token_version ?? 0 }, process.env.JWT_SECRET, {
    expiresIn: '30d', // long-lived on purpose (single-purpose app on your own phone); revocation is checked per request
  });

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });

    const key = attemptKey(req, username);
    if (isLimited(key)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });

    const { data: admin, error } = await supabase
      .from('admin_users')
      .select('id, username, password_hash, display_name, role, is_active, token_version')
      .eq('username', username)
      .maybeSingle();

    // Deliberately vague: don't reveal whether the username exists or the password was wrong.
    if (error || !admin || !(await bcrypt.compare(password, admin.password_hash))) {
      recordFailure(key);
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    if (!admin.is_active) {
      return res.status(403).json({ error: 'This account has been disabled. Contact the administrator.' });
    }

    failures.delete(key);
    res.json({ token: signToken(admin), username: admin.username, displayName: admin.display_name, role: admin.role });
  } catch (err) {
    console.error('[login]', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

router.get('/me', requireAuth, (req, res) => {
  const { adminId, username, displayName, role } = req.admin;
  res.json({ id: adminId, username, displayName, role });
});

// Any user can change their own password. Old tokens stop working; the response carries a fresh one.
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'currentPassword and newPassword required' });
    }
    if (newPassword.length < 8 || newPassword.length > 72) {
      return res.status(400).json({ error: 'New password must be 8 to 72 characters' });
    }

    const { data: user, error } = await supabase
      .from('admin_users')
      .select('id, username, password_hash, token_version')
      .eq('id', req.admin.adminId)
      .single();
    if (error || !user) return res.status(500).json({ error: 'Could not load your account' });
    if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const token_version = (user.token_version ?? 0) + 1;
    const { error: upErr } = await supabase
      .from('admin_users')
      .update({ password_hash: await bcrypt.hash(newPassword, 10), token_version })
      .eq('id', user.id);
    if (upErr) return res.status(500).json({ error: upErr.message });

    res.json({ token: signToken({ ...user, token_version }) });
  } catch (err) {
    console.error('[change-password]', err.message);
    res.status(500).json({ error: 'Could not change password' });
  }
});

export default router;