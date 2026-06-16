import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

function getSupabaseUrlHost(value?: string): string {
  if (!value) {
    return 'not-configured';
  }

  try {
    return new URL(value).host;
  } catch {
    return 'invalid-url';
  }
}

export const supabaseUrlHost = getSupabaseUrlHost(supabaseUrl);

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl as string, supabaseAnonKey as string)
  : null;
