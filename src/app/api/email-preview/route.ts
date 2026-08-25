export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ message: "이메일 알림은 준비 중입니다. 현재는 웹 알림만 제공합니다." }, { status: 501 });
}
