import { requireUser } from "@/lib/auth";
import { SupabaseRepository } from "@/lib/repository";
import { createSupabaseAdminClient } from "@/lib/supabase";

export async function currentRepository() {
  const user = await requireUser();
  const { data } = await createSupabaseAdminClient().from("allowed_users").select("role, active").eq("email", user.email?.toLowerCase() ?? "").maybeSingle();
  if (!data?.active) throw new Error("허용되지 않은 사용자입니다.");
  return { user, isAdmin: data.role === "admin", repository: new SupabaseRepository(user.id) };
}
