import { enqueuePendingAttachmentJobs, finishActiveBatchIfDrained, processPendingAttachmentJobsInline } from "@/lib/attachment-pass";
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
    const collection = await runCollectionPass(new Date(String(started.started_at)));
    await admin.from("batch_runs").update({ status: "분석 중", discovered: collection.discovered, changed: collection.changed, api_calls: collection.queryCount, window_start: collection.windowStart, window_end: collection.windowEnd, window_hours: collection.windowHours }).eq("id", started.id);
    const queue = await enqueuePendingAttachmentJobs(40);
    const inlineProcessed = await processPendingAttachmentJobsInline(16);
    const aiQueue = await enqueueReadyNoticeAiJobs();
    const inlineAiProcessed = await processPendingNoticeAiJobsInline(8);
    const result = { ...collection, ...queue, ...aiQueue, inlineProcessed, inlineAiProcessed, analyzed: inlineAiProcessed };
    const { error: finishError } = await admin.from("batch_runs").update({
      status: queue.attachmentQueued || aiQueue.aiQueued ? "분석 중" : "완료", completed_at: queue.attachmentQueued || aiQueue.aiQueued ? null : new Date().toISOString(), discovered: result.discovered,
      changed: result.changed, analyzed: result.analyzed, api_calls: result.queryCount,
      error_summary: queue.attachmentQueued || aiQueue.aiQueued ? `첨부문서 ${queue.attachmentQueued}건, 공고 AI 분석 ${aiQueue.aiQueued}건을 대기열에 등록했습니다.` : null,
    }).eq("id", started.id);
    if (finishError) throw finishError;
    return result;
  } catch (error) {
    await admin.from("batch_runs").update({ completed_at: new Date().toISOString(), status: "부분 완료", error_summary: error instanceof Error ? error.message : "알 수 없는 오류" }).eq("id", started.id);
    throw error;
  }
}

/**
 * Long-running worker used by GitHub Actions. It deliberately bypasses
 * Vercel Queue and drains the durable Supabase job tables until every job is
 * terminal, so the public page can expose only a completed daily snapshot.
 */
export async function runGithubActionsBatch() {
  const admin = createSupabaseAdminClient();
  await admin.from("batch_runs").update({ status: "부분 완료", completed_at: new Date().toISOString(), error_summary: "새 작업자가 이전 실행을 인계했습니다." }).in("status", ["실행 중", "분석 중"]);
  const { data: started, error: startError } = await admin.from("batch_runs").insert({}).select().single();
  if (startError || !started) throw startError ?? new Error("실행 이력을 만들 수 없습니다.");
  try {
    await ensureDefaultTopic();
    const collection = await runCollectionPass(new Date(String(started.started_at)));
    await admin.from("batch_runs").update({ status: "분석 중", discovered: collection.discovered, changed: collection.changed, api_calls: collection.queryCount, window_start: collection.windowStart, window_end: collection.windowEnd, window_hours: collection.windowHours }).eq("id", started.id);
    // Register no-attachment notices once. Attachment-backed notices enqueue
    // their AI job from processQueuedAttachmentJob as soon as the final file
    // becomes ready; rescanning every notice on every cycle caused a large
    // Supabase round-trip bottleneck.
    await enqueueReadyNoticeAiJobs({ publish: false, noticeIds: collection.noticeIds });
    let attachmentProcessed = 0;
    let aiProcessed = 0;
    for (let cycle = 0; cycle < 1_000; cycle += 1) {
      console.log(`[Batch] cycle=${cycle + 1} attachmentProcessed=${attachmentProcessed} aiProcessed=${aiProcessed}`);
      attachmentProcessed += await processPendingAttachmentJobsInline(40, false, String(started.started_at));
      aiProcessed += await processPendingNoticeAiJobsInline(4, String(started.started_at));
      const [{ count: pendingAttachments }, { count: pendingAi }] = await Promise.all([
        admin.from("processing_jobs").select("id", { count: "exact", head: true }).in("status", ["대기", "처리 중"]).gte("created_at", String(started.started_at)),
        admin.from("notice_ai_jobs").select("id", { count: "exact", head: true }).in("status", ["대기", "처리 중"]).gte("created_at", String(started.started_at)),
      ]);
      console.log(`[Batch] pending attachments=${pendingAttachments ?? 0} ai=${pendingAi ?? 0}`);
      if ((pendingAttachments ?? 0) === 0 && (pendingAi ?? 0) === 0) break;
      if (attachmentProcessed === 0 && aiProcessed === 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    await finishActiveBatchIfDrained();
    const { count: analyzed } = await admin.from("topic_scores").select("id", { count: "exact", head: true }).gte("updated_at", String(started.started_at));
    const { count: remainingAttachments } = await admin.from("processing_jobs").select("id", { count: "exact", head: true }).in("status", ["대기", "처리 중"]);
    const { count: remainingAi } = await admin.from("notice_ai_jobs").select("id", { count: "exact", head: true }).in("status", ["대기", "처리 중"]);
    const { count: failedAttachments } = await admin.from("processing_jobs").select("id", { count: "exact", head: true }).eq("status", "실패").gte("updated_at", String(started.started_at));
    const { count: failedAi } = await admin.from("notice_ai_jobs").select("id", { count: "exact", head: true }).eq("status", "실패").gte("updated_at", String(started.started_at));
    const complete = (remainingAttachments ?? 0) === 0 && (remainingAi ?? 0) === 0 && (failedAttachments ?? 0) === 0 && (failedAi ?? 0) === 0;
    const errorSummary = complete ? null : `처리 미완료: 대기 첨부 ${remainingAttachments ?? 0}건·대기 AI ${remainingAi ?? 0}건·실패 첨부 ${failedAttachments ?? 0}건·실패 AI ${failedAi ?? 0}건`;
    await admin.from("batch_runs").update({ status: complete ? "완료" : "부분 완료", completed_at: new Date().toISOString(), discovered: collection.discovered, changed: collection.changed, analyzed: analyzed ?? 0, api_calls: collection.queryCount, window_start: collection.windowStart, window_end: collection.windowEnd, window_hours: collection.windowHours, error_summary: errorSummary }).eq("id", started.id);
    return { ...collection, attachmentProcessed, aiProcessed, analyzed: analyzed ?? 0, complete };
  } catch (error) {
    await admin.from("batch_runs").update({ status: "부분 완료", completed_at: new Date().toISOString(), error_summary: error instanceof Error ? error.message : "작업자 실행 실패" }).eq("id", started.id);
    throw error;
  }
}
