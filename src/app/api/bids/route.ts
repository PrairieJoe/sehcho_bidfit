import { repository } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(repository.listNotices());
}
