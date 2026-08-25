import { currentRepository } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  try { return Response.json(await (await currentRepository()).repository.listNotices()); } catch { return Response.json({ message: "인증이 필요합니다." }, { status: 401 }); }
}
