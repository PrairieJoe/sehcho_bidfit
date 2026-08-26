import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getSetupStatus } from "@/lib/setup";

export async function GET() {
  try { await requireAdmin(); return NextResponse.json(await getSetupStatus()); }
  catch (error) { return NextResponse.json({ message: error instanceof Error ? error.message : "관리자 권한이 필요합니다." }, { status: 403 }); }
}
