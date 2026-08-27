import { enqueuePendingAttachmentJobs, processPendingAttachmentJobsInline } from "@/lib/attachment-pass";
import { runCollectionPass } from "@/lib/collection-pass";
import { enqueueReadyNoticeAiJobs, processPendingNoticeAiJobsInline } from "@/lib/notice-ai-pass";
import { ensureDefaultTopic } from "@/lib/repository";
import { createSupabaseAdminClient } from "@/lib/supabase";

/** Runs the daily unit of work and records the outcome shown on the dashboard. */
export async function runDailyBatch() {
  const admin = createSupabaseAdminClient();
  const { data: active } = await admin.from("batch_runs").select("id,started_at").in("status", ["실행 중", "분석 중"]).order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (active) {
    const age = Date.now() - new Date(String(active.started_at)).getTime();
    // A hosted function cannot remain active beyond its execution window.
    // Recover a run that has made no progress for five minutes so the next
    // scheduled/manual run can resume instead of being blocked for 30 minutes.
    if (age < 5 * 60_000) throw new Error("이미 분석 중인 배치가 있습니다. 현재 작업이 끝난 뒤 다시 실행하세요.");
    await admin.from("batch_runs").update({ status: "부분 완료", completed_at: new Date().toISOString(), error_summary: "30분 이상 진행되지 않아 정체 배치로 종료했습니다." }).eq("id", active.id);
  }
  await admin.from("batch_runs").update({ completed_at: new Date().toISOString(), status: "부분 완료", error_summary: "다음 일일 작업이 시작되어 이전 분석 대기 작업을 종료했습니다." }).in("status", ["실행 중", "분석 중"]);
  const { data: started, error: startError } = await admin.from("batch_runs").insert({}).select().single();
  if (startError || !started) throw startError ?? new Error("실행 이력을 만들 수 없습니다.");
  try {
    await ensureDefaultTopic();
    const collection = await runCollectionPass();
    await admin.from("batch_runs").update({ status: "분석 중", discovered: collection.discovered, changed: collection.changed, api_calls: 4 }).eq("id", started.id);
    const queue = await enqueuePendingAttachmentJobs(40);
    const inlineProcessed = await processPendingAttachmentJobsInline(16);
    const aiQueue = await enqueueReadyNoticeAiJobs();
    const inlineAiProcessed = await processPendingNoticeAiJobsInline(8);
    const result = { ...collection, ...queue, ...aiQueue, inlineProcessed, inlineAiProcessed, analyzed: inlineAiProcessed };
    const { error: finishError } = await admin.from("batch_runs").update({
      status: queue.attachmentQueued || aiQueue.aiQueued ? "분석 중" : "완료", completed_at: queue.attachmentQueued || aiQueue.aiQueued ? null : new Date().toISOString(), discovered: result.discovered,
      changed: result.changed, analyzed: result.analyzed, api_calls: 4,
      error_summary: queue.attachmentQueued || aiQueue.aiQueued ? `첨부문서 ${queue.attachmentQueued}건, 공고 AI 분석 ${aiQueue.aiQueued}건을 대기열에 등록했습니다.` : null,
    }).eq("id", started.id);
    if (finishError) throw finishError;
    return result;
  } catch (error) {
    await admin.from("batch_runs").update({ completed_at: new Date().toISOString(), status: "부분 완료", error_summary: error instanceof Error ? error.message : "알 수 없는 오류" }).eq("id", started.id);
    throw error;
  }
}
