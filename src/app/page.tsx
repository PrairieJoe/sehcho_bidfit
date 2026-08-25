import { Dashboard } from "@/components/dashboard";
import { currentRepository } from "@/lib/session";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Home() {
  let session;
  try { session = await currentRepository(); } catch { redirect("/login"); }
  const { repository, user, isAdmin } = session!;
  return <Dashboard initialNotices={await repository.listNotices()} initialTopic={await repository.getTopic()} initialNotifications={await repository.listNotifications()} initialRuns={await repository.listRuns()} userEmail={user.email ?? "사용자"} isAdmin={isAdmin} />;
}
