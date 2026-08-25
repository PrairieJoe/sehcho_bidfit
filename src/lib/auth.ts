import { createSupabaseAdminClient, createSupabaseServerClient, isSupabaseConfigured } from "@/lib/supabase";

export async function requireUser() {
  if (!isSupabaseConfigured()) throw new Error("Supabase 인증이 아직 설정되지 않았습니다.");
  const client = await createSupabaseServerClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) throw new Error("인증이 필요합니다.");
  return user;
}

export function unauthorizedResponse() {
  return Response.json({ message: "인증이 필요합니다." }, { status: 401 });
}

export async function requireAdmin() {
  const user = await requireUser();
  const { data, error } = await createSupabaseAdminClient().from("allowed_users").select("role, active").eq("email", user.email?.toLowerCase() ?? "").maybeSingle();
  if (error || !data?.active || data.role !== "admin") throw new Error("관리자 권한이 필요합니다.");
  return user;
}
