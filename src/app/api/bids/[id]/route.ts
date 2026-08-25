import { currentRepository } from "@/lib/session";
import { requireAdmin } from "@/lib/auth";
import type { ReviewState } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let notice;
  try { notice = await (await currentRepository()).repository.getNotice(id); } catch { return Response.json({ message: "인증이 필요합니다." }, { status: 401 }); }
  return notice ? Response.json(notice) : Response.json({ message: "공고를 찾을 수 없습니다." }, { status: 404 });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const payload = await request.json() as { reviewState?: ReviewState; memo?: string };
  let notice;
  try { await requireAdmin(); notice = await (await currentRepository()).repository.updateNotice(id, { reviewState: payload.reviewState ?? "검토 전", memo: payload.memo ?? "" }); } catch { return Response.json({ message: "관리자 권한이 필요합니다." }, { status: 403 }); }
  return notice ? Response.json(notice) : Response.json({ message: "공고를 찾을 수 없습니다." }, { status: 404 });
}
