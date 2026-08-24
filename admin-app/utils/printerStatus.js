// The Pi worker heartbeats every ~5 seconds while running. If we haven't
// heard from it recently, treat it as offline regardless of what the last
// stored pi_internet_online/pi_printer_connected values say — a Pi that's
// been switched off can't update its own row to say so, so those flags
// just freeze at whatever they last were (usually "online"). This exact
// bug showed up first on the kiosk website ("Printer Ready" shown even
// with the Pi powered off) and turned out to affect this app's status
// dots too, since they were reading the raw flags directly.
const HEARTBEAT_STALE_MS = 20000;

export function isHeartbeatFresh(lastHeartbeat) {
  if (!lastHeartbeat) return false;
  return Date.now() - new Date(lastHeartbeat).getTime() <= HEARTBEAT_STALE_MS;
}

// A printer only counts as genuinely online if BOTH the heartbeat is
// recent AND the stored flag itself says true — stale data is never
// trusted as "online" just because it hasn't been contradicted yet.
export function isInternetOnline(printer) {
  return isHeartbeatFresh(printer.last_heartbeat) && !!printer.pi_internet_online;
}

export function isPrinterConnected(printer) {
  return isHeartbeatFresh(printer.last_heartbeat) && !!printer.pi_printer_connected;
}