import { runGithubActionsBatch } from "../src/lib/batch-pass";
import { createSupabaseAdminClient } from "../src/lib/supabase";

function kstDayBounds(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).reduce<Record<string, string>>((memo, part) => ({ ...memo, [part.type]: part.value }), {});
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const start = new Date(`${day}T00:00:00+09:00`);
  return { start, end: new Date(start.getTime() + 24 * 3_600_000) };
}

async function alreadyCompletedToday() {
  const { start, end } = kstDayBounds();
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.from("batch_runs").select("id,started_at").eq("status", "완료").gte("started_at", start.toISOString()).lt("started_at", end.toISOString()).limit(1).maybeSingle();
  if (error) throw error;
  return data;
}

async function main() {
  const force = String(process.env.FORCE_DAILY_BATCH ?? "false").toLowerCase() === "true";
  if (!force) {
    const completed = await alreadyCompletedToday();
    if (completed) {
      console.log(`[workflow] 오늘 이미 완료된 배치가 있어 재시도를 건너뜁니다: ${completed.started_at}`);
      return;
    }
  } else {
    console.log("[workflow] force=true: 오늘 완료 배치 중복 가드를 우회하고 실제 수집·분석을 실행합니다.");
  }
  const result = await runGithubActionsBatch();
  console.log(JSON.stringify({
    discovered: result.discovered,
    attachmentProcessed: result.attachmentProcessed,
    aiProcessed: result.aiProcessed,
    analyzed: result.analyzed,
    complete: result.complete,
  }, null, 2));
  if (!result.complete) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
