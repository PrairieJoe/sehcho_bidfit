import { currentRepository } from "@/lib/session";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  try { return Response.json(await (await currentRepository()).repository.listNotifications()); } catch { return Response.json({ message: "인증이 필요합니다." }, { status: 401 }); }
}

export async function PATCH(request: Request) {
  const { id } = await request.json() as { id: string };
  let notification;
  try { await requireAdmin(); notification = await (await currentRepository()).repository.markNotificationRead(id); } catch { return Response.json({ message: "관리자 권한이 필요합니다." }, { status: 403 }); }
  return notification ? Response.json(notification) : Response.json({ message: "알림을 찾을 수 없습니다." }, { status: 404 });
}
