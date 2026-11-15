import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { supabase } from '../db/supabaseAdmin.js';
import { isUuid, requireSuperAdmin } from '../middleware/access.js';

const router = Router();
router.use(requireSuperAdmin);

const USERNAME = /^[a-zA-Z0-9._-]{3,32}$/;
const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');
const fail = (res, status, error) => res.status(status).json({ error });
const serverError = (res, where, err) => {
  console.error(`[users:${where}]`, err.message || err);
  return fail(res, 500, 'Something went wrong. Please try again.');
};

router.param('id', (req, res, next, id) => (isUuid(id) ? next() : fail(res, 400, 'Invalid user id')));

const toPublic = (u, extra = {}) => ({
  id: u.id,
  username: u.username,
  displayName: u.display_name,
  role: u.role,
  isActive: u.is_active,
  createdAt: u.created_at,
  ...extra,
});

// Roles other than VENDOR are managed directly in the database on purpose: the API can't be used to
// create, demote, disable or delete a super admin.
async function loadVendor(res, id) {
  const { data: user, error } = await supabase
    .from('admin_users')
    .select('id, username, display_name, role, is_active, created_at')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    serverError(res, 'load', error);
    return null;
  }
  if (!user) {
    fail(res, 404, 'User not found');
    return null;
  }
  if (user.role !== 'VENDOR') {
    fail(res, 403, 'Super admin accounts are managed directly in the database');
    return null;
  }
  return user;
}

// Returns a de-duplicated array of ids that all exist, or { error }.
async function checkPrinterIds(input) {
  if (!Array.isArray(input)) return { error: 'printerIds must be an array' };
  const ids = [...new Set(input)];
  if (!ids.every(isUuid)) return { error: 'printerIds contains an invalid id' };
  if (ids.length === 0) return { ids };
  const { data, error } = await supabase.from('printers').select('id').in('id', ids);
  if (error) throw new Error(error.message);
  if (data.length !== ids.length) return { error: 'One or more printers do not exist' };
  return { ids };
}

// GET /users
router.get('/', async (_req, res) => {
  try {
    const { data: users, error } = await supabase
      .from('admin_users')
      .select('id, username, display_name, role, is_active, created_at')
      .order('created_at', { ascending: true });
    if (error) throw error;
    const { data: access, error: accErr } = await supabase.from('printer_access').select('admin_user_id');
    if (accErr) throw accErr;

    const counts = {};
    for (const a of access) counts[a.admin_user_id] = (counts[a.admin_user_id] || 0) + 1;
    res.json(users.map((u) => toPublic(u, { printerCount: u.role === 'SUPER_ADMIN' ? null : counts[u.id] || 0 })));
  } catch (err) {
    serverError(res, 'list', err);
  }
});

// GET /users/printer-options — every printer, labelled with its institute, for the assignment picker
router.get('/printer-options', async (_req, res) => {
  try {
    const { data: printers, error } = await supabase.from('printers').select('id, name, institute_id');
    if (error) throw error;
    const { data: institutes, error: instErr } = await supabase.from('institutes').select('id, name');
    if (instErr) throw instErr;

    const names = Object.fromEntries(institutes.map((i) => [i.id, i.name]));
    const rows = printers.map((p) => ({ id: p.id, name: p.name, instituteId: p.institute_id, instituteName: names[p.institute_id] || 'Unknown institute' }));
    rows.sort((a, b) => a.instituteName.localeCompare(b.instituteName) || a.name.localeCompare(b.name));
    res.json(rows);
  } catch (err) {
    serverError(res, 'printer-options', err);
  }
});

// GET /users/vendors/overview?month=2026-11 — every vendor with that month's prints, pages and revenue
router.get('/vendors/overview', async (req, res) => {
  try {
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month || '') ? req.query.month : null;
    const now = new Date(Date.now() + 5.5 * 3600 * 1000); // Indian time
    const m = month || `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    const [{ data: users, error }, { data: stats, error: statErr }] = await Promise.all([
      supabase.from('admin_users').select('id, username, display_name, role, is_active, created_at, paused_printer_ids').eq('role', 'VENDOR'),
      supabase.rpc('admin_vendor_month_stats', { p_month: `${m}-01` }),
    ]);
    if (error) throw error;
    if (statErr) throw statErr;

    const byId = Object.fromEntries(stats.map((s) => [s.admin_user_id, s]));
    const vendors = users.map((u) => {
      const s = byId[u.id] || {};
      return toPublic(u, {
        printerCount: s.printer_count || 0,
        prints: Number(s.prints || 0),
        pages: Number(s.pages || 0),
        revenue: Number(s.revenue || 0),
        printersPaused: (u.paused_printer_ids || []).length,
      });
    });
    vendors.sort((a, b) => b.revenue - a.revenue || (a.displayName || a.username).localeCompare(b.displayName || b.username));
    res.json({
      month: m,
      totals: vendors.reduce((t, v) => ({ prints: t.prints + v.prints, pages: t.pages + v.pages, revenue: t.revenue + v.revenue }),
        { prints: 0, pages: 0, revenue: 0 }),
      vendors,
    });
  } catch (err) {
    serverError(res, 'overview', err);
  }
});

// POST /users/:id/pause  { printers: boolean }
// Signs the vendor out and blocks sign-in. With printers: true, also switches off every printer assigned to them
// (remembered, so Resume switches back on exactly those).
router.post('/:id/pause', async (req, res) => {
  try {
    const user = await loadVendor(res, req.params.id);
    if (!user) return;
    const patch = { is_active: false };
    if ((req.body || {}).printers === true) {
      const { data: access, error } = await supabase.from('printer_access').select('printer_id').eq('admin_user_id', user.id);
      if (error) throw error;
      const ids = access.map((a) => a.printer_id);
      let switchedOff = [];
      if (ids.length) {
        const { data: on, error: e2 } = await supabase.from('printers').update({ is_enabled: false })
          .in('id', ids).eq('is_enabled', true).select('id');
        if (e2) throw e2;
        switchedOff = on.map((p) => p.id);
      }
      const { data: row, error: e3 } = await supabase.from('admin_users').select('paused_printer_ids').eq('id', user.id).single();
      if (e3) throw e3;
      patch.paused_printer_ids = [...new Set([...(row.paused_printer_ids || []), ...switchedOff])];
    }
    const { error } = await supabase.from('admin_users').update(patch).eq('id', user.id);
    if (error) throw error;
    res.json({ success: true, printersSwitchedOff: patch.paused_printer_ids?.length || 0 });
  } catch (err) {
    serverError(res, 'pause', err);
  }
});

// POST /users/:id/resume — allows sign-in again and switches back on the printers that Pause switched off
router.post('/:id/resume', async (req, res) => {
  try {
    const user = await loadVendor(res, req.params.id);
    if (!user) return;
    const { data: row, error } = await supabase.from('admin_users').select('paused_printer_ids').eq('id', user.id).single();
    if (error) throw error;
    const ids = row.paused_printer_ids || [];
    if (ids.length) {
      const { error: e2 } = await supabase.from('printers').update({ is_enabled: true }).in('id', ids);
      if (e2) throw e2;
    }
    const { error: e3 } = await supabase.from('admin_users').update({ is_active: true, paused_printer_ids: null }).eq('id', user.id);
    if (e3) throw e3;
    res.json({ success: true, printersSwitchedOn: ids.length });
  } catch (err) {
    serverError(res, 'resume', err);
  }
});

// GET /users/:id
router.get('/:id', async (req, res) => {
  try {
    const user = await loadVendor(res, req.params.id);
    if (!user) return;
    const { data: access, error } = await supabase.from('printer_access').select('printer_id').eq('admin_user_id', user.id);
    if (error) throw error;
    res.json(toPublic(user, { printerIds: access.map((a) => a.printer_id) }));
  } catch (err) {
    serverError(res, 'get', err);
  }
});

// POST /users  { username, password, displayName?, printerIds? }  -> always creates a VENDOR
router.post('/', async (req, res) => {
  try {
    const { username, password, displayName, printerIds = [] } = req.body || {};
    if (typeof username !== 'string' || !USERNAME.test(username)) {
      return fail(res, 400, 'Username must be 3-32 characters: letters, numbers, dot, dash or underscore');
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
      return fail(res, 400, 'Password must be 8 to 72 characters');
    }
    if (displayName != null && (typeof displayName !== 'string' || displayName.length > 80)) {
      return fail(res, 400, 'Display name must be text up to 80 characters');
    }
    const checked = await checkPrinterIds(printerIds);
    if (checked.error) return fail(res, 400, checked.error);

    // Case-insensitive uniqueness, so "Rahul" and "rahul" can't both exist.
    const { data: clash, error: clashErr } = await supabase.from('admin_users').select('id').ilike('username', escapeLike(username));
    if (clashErr) throw clashErr;
    if (clash.length > 0) return fail(res, 409, 'That username is already taken');

    const { data: created, error } = await supabase
      .from('admin_users')
      .insert({ username, password_hash: await bcrypt.hash(password, 10), display_name: displayName?.trim() || null, role: 'VENDOR' })
      .select('id, username, display_name, role, is_active, created_at')
      .single();
    if (error) {
      if (/duplicate|unique/i.test(error.message)) return fail(res, 409, 'That username is already taken');
      throw error;
    }

    if (checked.ids.length > 0) {
      const { error: accErr } = await supabase.from('printer_access').insert(checked.ids.map((printer_id) => ({ admin_user_id: created.id, printer_id })));
      if (accErr) throw accErr;
    }
    res.status(201).json(toPublic(created, { printerIds: checked.ids }));
  } catch (err) {
    serverError(res, 'create', err);
  }
});

// PATCH /users/:id  { displayName?, isActive?, password? }
// A password reset also signs the user out everywhere (token_version bump).
router.patch('/:id', async (req, res) => {
  try {
    const user = await loadVendor(res, req.params.id);
    if (!user) return;
    const { displayName, isActive, password } = req.body || {};
    const patch = {};

    if (displayName !== undefined) {
      if (displayName !== null && (typeof displayName !== 'string' || displayName.length > 80)) return fail(res, 400, 'Display name must be text up to 80 characters');
      patch.display_name = displayName ? displayName.trim() : null;
    }
    if (isActive !== undefined) {
      if (typeof isActive !== 'boolean') return fail(res, 400, 'isActive must be true or false');
      patch.is_active = isActive;
    }
    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < 8 || password.length > 72) return fail(res, 400, 'Password must be 8 to 72 characters');
      const { data: row, error } = await supabase.from('admin_users').select('token_version').eq('id', user.id).single();
      if (error) throw error;
      patch.password_hash = await bcrypt.hash(password, 10);
      patch.token_version = (row.token_version ?? 0) + 1;
    }
    if (Object.keys(patch).length === 0) return fail(res, 400, 'Nothing to update');

    const { error } = await supabase.from('admin_users').update(patch).eq('id', user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    serverError(res, 'update', err);
  }
});

// PUT /users/:id/printers  { printerIds: [...] }  — replaces the user's whole assignment set
router.put('/:id/printers', async (req, res) => {
  try {
    const user = await loadVendor(res, req.params.id);
    if (!user) return;
    const checked = await checkPrinterIds((req.body || {}).printerIds);
    if (checked.error) return fail(res, 400, checked.error);

    const { data: current, error } = await supabase.from('printer_access').select('printer_id').eq('admin_user_id', user.id);
    if (error) throw error;
    const have = new Set(current.map((r) => r.printer_id));
    const want = new Set(checked.ids);
    const toAdd = checked.ids.filter((id) => !have.has(id));
    const toRemove = [...have].filter((id) => !want.has(id));

    // Add first, then remove, so a failure part-way never leaves the user with less than before AND after.
    if (toAdd.length > 0) {
      const { error: addErr } = await supabase.from('printer_access').insert(toAdd.map((printer_id) => ({ admin_user_id: user.id, printer_id })));
      if (addErr) throw addErr;
    }
    if (toRemove.length > 0) {
      const { error: rmErr } = await supabase.from('printer_access').delete().eq('admin_user_id', user.id).in('printer_id', toRemove);
      if (rmErr) throw rmErr;
    }
    res.json({ success: true, printerIds: checked.ids });
  } catch (err) {
    serverError(res, 'assign', err);
  }
});

// DELETE /users/:id
router.delete('/:id', async (req, res) => {
  try {
    const user = await loadVendor(res, req.params.id);
    if (!user) return;
    const { error } = await supabase.from('admin_users').delete().eq('id', user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    serverError(res, 'delete', err);
  }
});

export default router;
