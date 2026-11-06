import cron from 'node-cron';
import { supabase } from '../db/supabaseAdmin.js';

const CARTRIDGE_DUTY_CYCLE = Number(process.env.CARTRIDGE_DUTY_CYCLE || 10000);
const CARTRIDGE_WARNING_MARGIN = Number(process.env.CARTRIDGE_WARNING_MARGIN || 500);
const HEARTBEAT_STALE_MS = 60000; // matches the kiosk's own staleness window, roughly

// Alerts go to super admins plus the active vendors assigned to THAT printer, never to everyone.
export async function recipientTokensForPrinter(printerId) {
  const { data: tokens, error } = await supabase.from('admin_device_tokens').select('expo_push_token, admin_user_id');
  if (error || !tokens?.length) return [];

  const userIds = [...new Set(tokens.map((t) => t.admin_user_id).filter(Boolean))];
  if (userIds.length === 0) return [];
  const { data: users } = await supabase.from('admin_users').select('id, role, is_active').in('id', userIds);
  const { data: access } = await supabase.from('printer_access').select('admin_user_id').eq('printer_id', printerId);

  const assigned = new Set((access || []).map((a) => a.admin_user_id));
  const allowed = new Set(
    (users || []).filter((u) => u.is_active && (u.role === 'SUPER_ADMIN' || assigned.has(u.id))).map((u) => u.id)
  );
  return [...new Set(tokens.filter((t) => allowed.has(t.admin_user_id)).map((t) => t.expo_push_token))];
}

async function sendPushForPrinter(printerId, title, body) {
  const recipients = await recipientTokensForPrinter(printerId);
  if (recipients.length === 0) return;

  const messages = recipients.map((to) => ({ to, sound: 'default', title, body }));

  // Expo's push API accepts up to 100 messages per request.
  for (let i = 0; i < messages.length; i += 100) {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages.slice(i, i + 100)),
    }).catch((err) => console.error('Push send failed:', err));
  }
}

// Fires the notification only on the OK -> problem transition, and once
// more when it clears back to OK. Prevents re-notifying every single check
// cycle while a problem is ongoing.
async function evaluateAlert(printerId, alertType, isNowActive, title, body) {
  const { data: state } = await supabase
    .from('printer_alert_state')
    .select('is_active')
    .eq('printer_id', printerId)
    .eq('alert_type', alertType)
    .maybeSingle();

  const wasActive = state?.is_active ?? false;

  if (isNowActive && !wasActive) {
    await sendPushForPrinter(printerId, title, body);
  } else if (!isNowActive && wasActive) {
    await sendPushForPrinter(printerId, `Resolved: ${title}`, `${body} — this has now cleared.`);
  }

  await supabase
    .from('printer_alert_state')
    .upsert(
      { printer_id: printerId, alert_type: alertType, is_active: isNowActive, last_notified_at: new Date().toISOString() },
      { onConflict: 'printer_id,alert_type' }
    );
}

async function checkAllPrinters() {
  const { data: printers, error } = await supabase
    .from('printers')
    .select('id, name, paper_remaining, min_paper_threshold, cartridge_page_count, pi_internet_online, pi_printer_connected, last_heartbeat');
  if (error) {
    console.error('[alert monitor] failed to fetch printers:', error.message);
    return;
  }

  for (const p of printers) {
    const heartbeatStale =
      !p.last_heartbeat || Date.now() - new Date(p.last_heartbeat).getTime() > HEARTBEAT_STALE_MS;

    await evaluateAlert(
      p.id, 'OFFLINE_INTERNET',
      heartbeatStale || !p.pi_internet_online,
      `${p.name}: internet offline`,
      `The Raspberry Pi for "${p.name}" has lost internet connectivity, or hasn't checked in recently.`
    );

    await evaluateAlert(
      p.id, 'PRINTER_DISCONNECTED',
      !heartbeatStale && !p.pi_printer_connected,
      `${p.name}: printer disconnected`,
      `The Pi can't reach the physical printer for "${p.name}" — check the USB connection, or whether something else is plugged in instead.`
    );

    await evaluateAlert(
      p.id, 'LOW_PAPER',
      p.paper_remaining < p.min_paper_threshold,
      `${p.name}: paper running low`,
      `Only ${p.paper_remaining} pages left. Refill and update the count in the admin app.`
    );

    await evaluateAlert(
      p.id, 'CARTRIDGE_NEAR_LIMIT',
      p.cartridge_page_count >= CARTRIDGE_DUTY_CYCLE - CARTRIDGE_WARNING_MARGIN,
      `${p.name}: cartridge nearing end of life`,
      `${p.cartridge_page_count}/${CARTRIDGE_DUTY_CYCLE} pages printed on this cartridge. Consider replacing it soon.`
    );
  }
}

export function startAlertMonitor() {
  const intervalMinutes = Number(process.env.ALERT_CHECK_INTERVAL_MINUTES || 2);
  console.log(`[alert monitor] checking every ${intervalMinutes} minute(s)`);
  cron.schedule(`*/${intervalMinutes} * * * *`, checkAllPrinters);
  // Also run once immediately on startup rather than waiting for the first tick.
  checkAllPrinters();
}