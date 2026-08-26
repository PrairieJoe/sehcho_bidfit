import { Dashboard } from "@/components/dashboard";
import { currentRepository } from "@/lib/session";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getSetupStatus } from "@/lib/setup";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!isSupabaseConfigured() || !(await getSetupStatus()).ready) redirect("/admin?setup=required");
  const { repository, isAdmin } = await currentRepository();
  return <Dashboard initialNotices={await repository.listNotices()} initialTopic={await repository.getTopic()} initialNotifications={await repository.listNotifications()} initialRuns={await repository.listRuns()} userEmail={isAdmin ? "관리자" : "공개 사용자"} isAdmin={isAdmin} />;
}
