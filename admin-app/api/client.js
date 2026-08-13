import AsyncStorage from '@react-native-async-storage/async-storage';

// Point this at wherever you deployed admin-backend (see its SETUP.md).
// Using your laptop's LAN IP works fine for local testing on the same wifi
// as your phone, e.g. 'http://192.168.1.42:4000' — 'localhost' will NOT
// work from a physical phone, only from an emulator on the same machine.
export const API_BASE_URL = 'http://192.168.1.42:4000';

const TOKEN_KEY = 'spy_admin_token';

export async function saveToken(token) {
  await AsyncStorage.setItem(TOKEN_KEY, token);
}

export async function getToken() {
  return AsyncStorage.getItem(TOKEN_KEY);
}

export async function clearToken() {
  await AsyncStorage.removeItem(TOKEN_KEY);
}

async function request(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = await getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  login: (username, password) =>
    request('/auth/login', { method: 'POST', body: { username, password }, auth: false }),

  getInstitutes: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/institutes${qs ? `?${qs}` : ''}`);
  },
  getStates: () => request('/institutes/states'),
  getPrinters: (instituteId) => request(`/institutes/${instituteId}/printers`),

  getPrinterStatus: (printerId) => request(`/printers/${printerId}/status`),
  getPrinterHistory: (printerId, days = 30) => request(`/printers/${printerId}/history?days=${days}`),
  setPrinterEnabled: (printerId, isEnabled) =>
    request(`/printers/${printerId}/enable`, { method: 'PATCH', body: { is_enabled: isEnabled } }),
  setPaperRemaining: (printerId, paperRemaining) =>
    request(`/printers/${printerId}/paper`, { method: 'PATCH', body: { paper_remaining: paperRemaining } }),
  resetCartridge: (printerId) => request(`/printers/${printerId}/reset-cartridge`, { method: 'POST' }),

  getFinanceToday: (printerId) => request(`/finance/${printerId}/today`),
  getFinanceTotal: (printerId) => request(`/finance/${printerId}/total`),
  getFinanceHistory: (printerId, page = 1) => request(`/finance/${printerId}/history?page=${page}`),

  registerDevice: (expoPushToken) => request('/devices', { method: 'POST', body: { expoPushToken } }),
};