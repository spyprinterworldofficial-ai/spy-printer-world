import { app } from './app.js';
import { startAlertMonitor } from './alerts/monitor.js';

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`S.py admin backend running on port ${port}`);
  startAlertMonitor();
});