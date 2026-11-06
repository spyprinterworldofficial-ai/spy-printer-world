import { supabase } from '../db/supabaseAdmin.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID.test(v);

export function requireSuperAdmin(req, res, next) {
  if (req.admin?.role !== 'SUPER_ADMIN') return res.status(403).json({ error: 'Super admin only' });
  next();
}

/** Printer ids this admin may operate. null means "every printer" (super admin). */
export async function accessiblePrinterIds(admin) {
  if (admin.role === 'SUPER_ADMIN') return null;
  const { data, error } = await supabase.from('printer_access').select('printer_id').eq('admin_user_id', admin.adminId);
  if (error) throw new Error(error.message);
  return data.map((r) => r.printer_id);
}

/** Institutes containing at least one printer this admin may see. null means "all". */
export async function visibleInstituteIds(admin) {
  const printerIds = await accessiblePrinterIds(admin);
  if (printerIds === null) return null;
  if (printerIds.length === 0) return [];
  const { data, error } = await supabase.from('printers').select('institute_id').in('id', printerIds);
  if (error) throw new Error(error.message);
  return [...new Set(data.map((r) => r.institute_id))];
}

/**
 * Use with router.param('id', printerAccessParam). Express runs it for every route containing that
 * parameter, so a route added later can't forget the check.
 */
export async function printerAccessParam(req, res, next, printerId) {
  try {
    if (!isUuid(printerId)) return res.status(400).json({ error: 'Invalid printer id' });
    const ids = await accessiblePrinterIds(req.admin);
    if (ids !== null && !ids.includes(printerId)) {
      return res.status(403).json({ error: "You don't have access to this printer" });
    }
    next();
  } catch (err) {
    console.error('[access]', err.message);
    res.status(503).json({ error: 'Temporary problem checking access. Please try again.' });
  }
}