import { currentRepository } from "@/lib/session";
import { requireAdmin } from "@/lib/auth";
import { runDailyBatch } from "@/lib/batch-pass";

export const dynamic = "force-dynamic";

export async function GET() {
  try { return Response.json(await (await currentRepository()).repository.listRuns()); } catch { return Response.json({ message: "인증이 필요합니다." }, { status: 401 }); }
}

export async function POST() {
  try { await requireAdmin(); return Response.json(await runDailyBatch(), { status: 201 }); } catch (error) { return Response.json({ message: error instanceof Error ? error.message : "배치 실행에 실패했습니다." }, { status: 500 }); }
}
