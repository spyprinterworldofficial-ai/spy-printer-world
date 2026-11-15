// India has no daylight saving, so "midnight in India" is always 18:30 UTC of the previous day.
const IST_MS = 5.5 * 3600 * 1000;

/** Start of today in Indian time, as a UTC Date (the server itself runs on UTC). */
export function startOfTodayIST() {
  const d = new Date(Date.now() + IST_MS);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - IST_MS);
}
