import { NextRequest, NextResponse } from "next/server";
import { createAdminSession, isAdminCodeConfigured, verifyAdminCode } from "@/lib/admin-session";
import { hasAdminSession } from "@/lib/admin-session";

export const dynamic = "force-dynamic";

export async function GET() { return NextResponse.json({ authenticated: await hasAdminSession(), configured: isAdminCodeConfigured() }); }

export async function POST(request: NextRequest) {
  if (!isAdminCodeConfigured()) return NextResponse.json({ message: "관리자 코드가 아직 Vercel에 설정되지 않았습니다." }, { status: 503 });
  const { code } = await request.json() as { code?: string };
  if (!verifyAdminCode(String(code ?? ""))) return NextResponse.json({ message: "관리자 코드가 올바르지 않습니다." }, { status: 401 });
  const response = NextResponse.json({ ok: true }); createAdminSession(response); return response;
}

export async function DELETE() { const response = NextResponse.json({ ok: true }); const { clearAdminSession } = await import("@/lib/admin-session"); clearAdminSession(response); return response; }
