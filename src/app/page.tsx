import { Dashboard } from "@/components/dashboard";
import { repository } from "@/lib/store";

export const dynamic = "force-dynamic";

export default function Home() {
  return <Dashboard initialNotices={repository.listNotices()} initialTopic={repository.getTopic()} initialNotifications={repository.listNotifications()} initialRuns={repository.listRuns()} />;
}
