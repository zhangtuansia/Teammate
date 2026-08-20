import { createClient as supabaseCreateClient } from "@supabase/supabase-js";

export function createClient(url: string, anonKey: string) {
  return supabaseCreateClient(url, anonKey);
}

export function createServerClient(url: string, serviceRoleKey: string) {
  return supabaseCreateClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
