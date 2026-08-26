import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;

// Public pages use the server-side service client. The anon key is retained
// for optional Supabase browser integrations but is not required for this app.
export const isSupabaseConfigured = () => Boolean(url && process.env.SUPABASE_SERVICE_ROLE_KEY);

function requiredAdminConfig() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) throw new Error("Supabase 환경변수가 설정되지 않았습니다.");
  return { url, serviceRoleKey };
}

export function createSupabaseAdminClient() {
  const config = requiredAdminConfig();
  return createClient(config.url, config.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
}
