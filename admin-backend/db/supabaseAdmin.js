import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

// Server-side client with the service-role key. Never ship this key to the app or the browser.
export const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});