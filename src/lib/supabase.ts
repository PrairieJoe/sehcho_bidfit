import { createClient } from "@supabase/supabase-js";
import { runtimeEnv } from "@/lib/runtime-env";

const url = () => runtimeEnv("SUPABASE_URL") ?? runtimeEnv("NEXT_PUBLIC_SUPABASE_URL");

// Public pages use the server-side service client. The anon key is retained
// for optional Supabase browser integrations but is not required for this app.
export const isSupabaseConfigured = () => Boolean(url() && runtimeEnv("SUPABASE_SERVICE_ROLE_KEY"));

function requiredAdminConfig() {
  const serviceRoleKey = runtimeEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseUrl = url();
  if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase 환경변수가 설정되지 않았습니다.");
  return { url: supabaseUrl, serviceRoleKey };
}

export function createSupabaseAdminClient() {
  const config = requiredAdminConfig();
  return createClient(config.url, config.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
}
