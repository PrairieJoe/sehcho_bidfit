import { repository } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(repository.listNotifications());
}

export async function PATCH(request: Request) {
  const { id } = await request.json() as { id: string };
  const notification = repository.markNotificationRead(id);
  return notification ? Response.json(notification) : Response.json({ message: "알림을 찾을 수 없습니다." }, { status: 404 });
}
