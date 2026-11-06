import { API_BASE_URL, getToken, clearToken } from './client';
import { notifyUnauthorized } from './session';

async function call(path, { method = 'GET', body } = {}) {
  const token = await getToken();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) {
    await clearToken();
    notifyUnauthorized();
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const adminApi = {
  getMe: () => call('/auth/me'),
  changePassword: (currentPassword, newPassword) =>
    call('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } }),

  listUsers: () => call('/users'),
  getUser: (id) => call(`/users/${id}`),
  getPrinterOptions: () => call('/users/printer-options'),
  createUser: (body) => call('/users', { method: 'POST', body }),
  updateUser: (id, body) => call(`/users/${id}`, { method: 'PATCH', body }),
  setUserPrinters: (id, printerIds) => call(`/users/${id}/printers`, { method: 'PUT', body: { printerIds } }),
  deleteUser: (id) => call(`/users/${id}`, { method: 'DELETE' }),
};