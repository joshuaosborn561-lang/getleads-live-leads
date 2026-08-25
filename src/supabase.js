import { createClient } from "@supabase/supabase-js";

export function createSupabase(config) {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function throwIfError(result, context) {
  if (result?.error) {
    const err = new Error(`${context}: ${result.error.message}`);
    err.cause = result.error;
    throw err;
  }
  return result;
}
