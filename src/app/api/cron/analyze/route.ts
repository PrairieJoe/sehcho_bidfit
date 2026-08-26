import { NextRequest, NextResponse } from "next/server";
import { runAnalysisPass } from "@/lib/analysis-pass";

export const maxDuration = 60;
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  try { return NextResponse.json(await runAnalysisPass()); } catch (error) { return NextResponse.json({ message: error instanceof Error ? error.message : "분석 처리에 실패했습니다." }, { status: 500 }); }
}
