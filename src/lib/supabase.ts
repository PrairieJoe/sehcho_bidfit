import { createBrowserClient, createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = () => Boolean(url && anonKey && process.env.SUPABASE_SERVICE_ROLE_KEY);

function requiredConfig() {
  if (!url || !anonKey) throw new Error("Supabase 환경변수가 설정되지 않았습니다.");
  return { url, anonKey };
}

export function createSupabaseBrowserClient() {
  const config = requiredConfig();
  return createBrowserClient(config.url, config.anonKey);
}

export async function createSupabaseServerClient() {
  const config = requiredConfig();
  const cookieStore = await cookies();
  return createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (items) => {
        try {
          items.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Components cannot write cookies. Middleware refreshes sessions.
        }
      },
    },
  });
}

export function createSupabaseAdminClient() {
  const config = requiredConfig();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY가 설정되지 않았습니다.");
  return createClient(config.url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
}
