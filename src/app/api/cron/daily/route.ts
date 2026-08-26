import { NextRequest, NextResponse } from "next/server";
import { runDailyBatch } from "@/lib/batch-pass";

export const maxDuration = 60;
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  try { return NextResponse.json(await runDailyBatch()); } catch { return NextResponse.json({ message: "배치 실행에 실패했습니다. 운영 화면에서 이력을 확인하세요." }, { status: 500 }); }
}
