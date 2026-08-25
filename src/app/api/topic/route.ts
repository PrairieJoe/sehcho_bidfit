import { currentRepository } from "@/lib/session";
import { requireAdmin } from "@/lib/auth";
import type { Topic } from "@/lib/types";

export async function GET() {
  try { return Response.json(await (await currentRepository()).repository.getTopic()); } catch { return Response.json({ message: "인증이 필요합니다." }, { status: 401 }); }
}

export async function PATCH(request: Request) {
  const patch = await request.json() as Partial<Topic>;
  try { await requireAdmin(); return Response.json(await (await currentRepository()).repository.updateTopic(patch)); } catch { return Response.json({ message: "관리자 권한이 필요합니다." }, { status: 403 }); }
}
