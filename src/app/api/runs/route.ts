import { repository } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(repository.listRuns());
}

export async function POST() {
  const run = await repository.runDailyAnalysis();
  return Response.json(run, { status: 201 });
}
