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
  const { data, error } = await admin.from("batch_runs").select("id,started_at,discovered,analyzed,error_summary").eq("status", "완료").gte("started_at", start.toISOString()).lt("started_at", end.toISOString()).order("started_at", { ascending: false }).limit(20);
  if (error) throw error;
  // A zero-row/empty completion must not suppress the scheduled retry. A
  // batch is reusable as today's completed snapshot only when every notice
  // discovered by that batch has a durable Gemini result and no diagnostic
  // error was recorded. This also prevents an old false-positive completion
  // from masking a later partial run.
  return (data ?? []).find((row) => {
    const discovered = Number(row.discovered ?? 0);
    const analyzed = Number(row.analyzed ?? 0);
    return discovered > 0 && analyzed === discovered && !String(row.error_summary ?? "").trim();
  });
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
    diagnostics: result.diagnostics,
  }, null, 2));
  // A terminal partial batch is reported in Supabase and the dashboard; do
  // not rerun it five times in one workflow merely because a scan or an
  // unsupported attachment cannot become Gemini input.
  if (!result.drained) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
