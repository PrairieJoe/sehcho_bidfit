import { repository } from "@/lib/store";
import type { ReviewState } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const notice = repository.getNotice(id);
  return notice ? Response.json(notice) : Response.json({ message: "공고를 찾을 수 없습니다." }, { status: 404 });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const payload = await request.json() as { reviewState?: ReviewState; memo?: string };
  const notice = repository.updateNotice(id, { reviewState: payload.reviewState ?? "검토 전", memo: payload.memo ?? "" });
  return notice ? Response.json(notice) : Response.json({ message: "공고를 찾을 수 없습니다." }, { status: 404 });
}
