import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import authRoutes from './routes/auth.js';
import institutesRoutes from './routes/institutes.js';
import printersRoutes from './routes/printers.js';
import financeRoutes from './routes/finance.js';
import devicesRoutes from './routes/devices.js';
import usersRoutes from './routes/users.js';
import { requireAuth } from './middleware/auth.js';

export const app = express();
app.set('trust proxy', 1); // Render sits behind one proxy; without this every client looks like the same IP to the login rate limit
app.use(cors());
app.use(express.json());

// Login is the only unauthenticated route (plus /health). There is no registration endpoint:
// vendor accounts are created by a super admin from the app (/users), super admins via SQL.
app.use('/auth', authRoutes);

// Everything below requires a valid session. Per-printer access is enforced inside the routers.
app.use('/institutes', requireAuth, institutesRoutes);
app.use('/printers', requireAuth, printersRoutes);
app.use('/finance', requireAuth, financeRoutes);
app.use('/devices', requireAuth, devicesRoutes);
app.use('/users', requireAuth, usersRoutes); // super admin only (enforced in the router)

app.get('/health', (_req, res) => res.json({ ok: true }));