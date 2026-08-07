import { createClient } from '@supabase/supabase-js';

// Single shared client for all client-side components.
// Uses the public anon key — never put the service role key here.
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
);