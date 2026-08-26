import { enqueuePendingAttachmentJobs } from "@/lib/attachment-pass";
import { runCollectionPass } from "@/lib/collection-pass";
import { ensureDefaultTopic } from "@/lib/repository";
import { createSupabaseAdminClient } from "@/lib/supabase";

/** Runs the daily unit of work and records the outcome shown on the dashboard. */
export async function runDailyBatch() {
  const admin = createSupabaseAdminClient();
  await admin.from("batch_runs").update({ completed_at: new Date().toISOString(), status: "부분 완료", error_summary: "다음 일일 작업이 시작되어 이전 분석 대기 작업을 종료했습니다." }).in("status", ["실행 중", "분석 중"]);
  const { data: started, error: startError } = await admin.from("batch_runs").insert({}).select().single();
  if (startError || !started) throw startError ?? new Error("실행 이력을 만들 수 없습니다.");
  try {
    await ensureDefaultTopic();
    const collection = await runCollectionPass();
    const queue = await enqueuePendingAttachmentJobs();
    const result = { ...collection, ...queue, analyzed: 0 };
    const { error: finishError } = await admin.from("batch_runs").update({
      status: queue.attachmentQueued ? "분석 중" : "완료", completed_at: queue.attachmentQueued ? null : new Date().toISOString(), discovered: result.discovered,
      changed: result.changed, analyzed: result.analyzed, api_calls: 4,
      error_summary: queue.attachmentQueued ? `첨부문서 ${queue.attachmentQueued}건을 분석 대기열에 등록했습니다.` : null,
    }).eq("id", started.id);
    if (finishError) throw finishError;
    return result;
  } catch (error) {
    await admin.from("batch_runs").update({ completed_at: new Date().toISOString(), status: "부분 완료", error_summary: error instanceof Error ? error.message : "알 수 없는 오류" }).eq("id", started.id);
    throw error;
  }
}
