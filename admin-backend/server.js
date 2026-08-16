import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import authRoutes from './routes/auth.js';
import institutesRoutes from './routes/institutes.js';
import printersRoutes from './routes/printers.js';
import financeRoutes from './routes/finance.js';
import devicesRoutes from './routes/devices.js';
import { requireAuth } from './middleware/auth.js';
import { startAlertMonitor } from './alerts/monitor.js';

const app = express();
app.use(cors());
app.use(express.json());

// Login is the only unauthenticated route — no registration endpoint exists
// by design, matching "no registration" from the app spec. Admin accounts
// are created manually (see SETUP.md).
app.use('/auth', authRoutes);

// Everything below requires a valid JWT from /auth/login.
app.use('/institutes', requireAuth, institutesRoutes);
app.use('/printers', requireAuth, printersRoutes);
app.use('/finance', requireAuth, financeRoutes);
app.use('/devices', requireAuth, devicesRoutes);

app.get('/health', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`S.py admin backend running on port ${port}`);
  startAlertMonitor();
});