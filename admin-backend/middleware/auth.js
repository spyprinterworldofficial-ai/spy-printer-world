import jwt from 'jsonwebtoken';
import { supabase } from '../db/supabaseAdmin.js';

// The JWT only proves identity. Role, active flag and token version are read from the database on every
// request, so deactivating a user or resetting a password takes effect immediately, not after 30 days.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  try {
    const { data: user, error } = await supabase
      .from('admin_users')
      .select('id, username, display_name, role, is_active, token_version')
      .eq('id', payload.adminId)
      .maybeSingle();
    // A database hiccup must not log everyone out: 503, not 401.
    if (error) return res.status(503).json({ error: 'Temporary problem checking your account. Please try again.' });
    if (!user || !user.is_active || (payload.v ?? 0) !== (user.token_version ?? 0)) {
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }
    req.admin = { adminId: user.id, username: user.username, displayName: user.display_name, role: user.role };
    next();
  } catch (err) {
    console.error('[auth]', err.message);
    res.status(503).json({ error: 'Temporary problem checking your account. Please try again.' });
  }
}