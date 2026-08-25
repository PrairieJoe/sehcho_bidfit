import { Dashboard } from "@/components/dashboard";
import { currentRepository } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { repository, user, isAdmin } = await currentRepository();
  return <Dashboard initialNotices={await repository.listNotices()} initialTopic={await repository.getTopic()} initialNotifications={await repository.listNotifications()} initialRuns={await repository.listRuns()} userEmail={user.email ?? "사용자"} isAdmin={isAdmin} />;
}
