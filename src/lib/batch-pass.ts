import { enqueuePendingAttachmentJobs, finishActiveBatchIfDrained, processPendingAttachmentJobsInline, requeueAttachmentsMissingText, requeueTraditionalOcrCandidates } from "@/lib/attachment-pass";
import { runCollectionPass } from "@/lib/collection-pass";
import { enqueueReadyNoticeAiJobs, processPendingNoticeAiJobsInline } from "@/lib/notice-ai-pass";
import { ensureDefaultTopic } from "@/lib/repository";
import { createSupabaseAdminClient } from "@/lib/supabase";

async function countCurrentJobs(admin: any, table: string, noticeIds: string[], statuses: string[], attachmentRelation = false) {
  let total = 0;
  for (let index = 0; index < noticeIds.length; index += 100) {
    const select = attachmentRelation ? "id,attachments!inner(notice_id)" : "id";
    const column = attachmentRelation ? "attachments.notice_id" : "notice_id";
    const { count, error } = await admin.from(table).select(select, { count: "exact", head: true }).in(column, noticeIds.slice(index, index + 100)).in("status", statuses);
    if (error) throw error;
    total += count ?? 0;
  }
  return total;
}

const isGeminiAnalysis = (analysis: Record<string, unknown> | null | undefined) =>
  String(analysis?.aiModel ?? "").toLowerCase().startsWith("gemini");

type BatchDiagnostics = {
  geminiAttachment: number;
  geminiTitleOnly: number;
  attachmentNotReady: number;
  attachmentReadyWithoutGemini: number;
  noAttachmentWithoutGemini: number;
  quotaFailures: number;
  attachmentStatusSets: Record<string, number>;
  attachmentFailureReasons: Record<string, number>;
  aiFailureReasons: Record<string, number>;
};

export async function currentBatchDiagnostics(admin: any, noticeIds: string[], batchId: string, startedAt: string): Promise<BatchDiagnostics> {
  const result: BatchDiagnostics = { geminiAttachment: 0, geminiTitleOnly: 0, attachmentNotReady: 0, attachmentReadyWithoutGemini: 0, noAttachmentWithoutGemini: 0, quotaFailures: 0, attachmentStatusSets: {}, attachmentFailureReasons: {}, aiFailureReasons: {} };
  for (let index = 0; index < noticeIds.length; index += 100) {
    const ids = noticeIds.slice(index, index + 100);
    const { data, error } = await admin.from("notices").select("id,attachments(status,failure_reason,name),topic_scores(analysis)").in("id", ids);
    if (error) throw error;
    for (const notice of data ?? []) {
    const attachments = Array.isArray(notice.attachments) ? notice.attachments : [];
      const analyses = Array.isArray(notice.topic_scores) ? notice.topic_scores.map((row: any) => row.analysis as Record<string, unknown> | null) : [];
      const analyzed = analyses.some((analysis: Record<string, unknown> | null) => isGeminiAnalysis(analysis) && String(analysis?.batchId ?? "") === batchId);
      if (analyzed) {
        if (attachments.length) result.geminiAttachment += 1;
        else result.geminiTitleOnly += 1;
      } else if (!attachments.length) result.noAttachmentWithoutGemini += 1;
      else if (attachments.every((attachment: any) => String(attachment.status) === "분석 완료")) result.attachmentReadyWithoutGemini += 1;
      else {
        result.attachmentNotReady += 1;
        const statusSet = attachments.map((attachment: any) => String(attachment.status)).sort().join(" + ");
        result.attachmentStatusSets[statusSet] = (result.attachmentStatusSets[statusSet] ?? 0) + 1;
        for (const attachment of attachments) {
          if (String(attachment.status) === "분석 완료") continue;
        const reason = String(attachment.failure_reason ?? "사유 미기록");
        const name = String(attachment.name ?? "").toLowerCase();
        const extension = name.includes(".") ? name.split(".").pop() : "unknown";
        const diagnosticReason = `${extension}: ${reason}`;
        result.attachmentFailureReasons[diagnosticReason] = (result.attachmentFailureReasons[diagnosticReason] ?? 0) + 1;
        }
      }
    }
    const { data: jobs, error: jobsError } = await admin.from("notice_ai_jobs").select("status,failure_reason").in("notice_id", ids).gte("updated_at", startedAt).eq("status", "실패");
    if (jobsError) throw jobsError;
    for (const job of jobs ?? []) {
      const reason = String(job.failure_reason ?? "AI 분석 실패");
      result.aiFailureReasons[reason] = (result.aiFailureReasons[reason] ?? 0) + 1;
      if (/quota|429|RESOURCE_EXHAUSTED/i.test(reason)) result.quotaFailures += 1;
    }
  }
  return result;
}

/**
 * A force/recovery run can collect the exact same notice after its attachment
 * text was intentionally purged following a successful Gemini analysis. Keep
 * that immutable, source-hash-matched score in the new completed snapshot
 * instead of publishing an empty dashboard solely because there was no new
 * attachment work to perform.
 */
async function carryForwardUnchangedScores(admin: any, noticeIds: string[], batchId: string) {
  let carried = 0;
  for (let index = 0; index < noticeIds.length; index += 100) {
    const ids = noticeIds.slice(index, index + 100);
    const [{ data: notices, error: noticesError }, { data: scores, error: scoresError }] = await Promise.all([
      admin.from("notices").select("id,source_hash").in("id", ids),
      admin.from("topic_scores").select("id,notice_id,analysis").in("notice_id", ids),
    ]);
    if (noticesError) throw noticesError;
    if (scoresError) throw scoresError;
    const hashByNotice = new Map((notices ?? []).map((notice: any) => [String(notice.id), String(notice.source_hash ?? "")]));
    for (const score of scores ?? []) {
      const analysis = score.analysis as Record<string, unknown> | null;
      // A quota fallback is not a publishable result; only preserve Gemini
      // output whose source fingerprint still matches this notice.
      if (!analysis || !isGeminiAnalysis(analysis) || String(analysis.sourceHash ?? "") !== hashByNotice.get(String(score.notice_id))) continue;
      if (String(analysis.batchId ?? "") === batchId) continue;
      const { error } = await admin.from("topic_scores").update({ analysis: { ...analysis, batchId }, updated_at: new Date().toISOString() }).eq("id", score.id);
      if (error) throw error;
      carried += 1;
    }
  }
  return carried;
}

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
    await admin.from("batch_runs").update({ status: "부분 완료", completed_at: new Date().toISOString(), error_summary: "5분 이상 진행되지 않아 정체 배치로 종료했습니다." }).eq("id", active.id);
  }
  await admin.from("batch_runs").update({ completed_at: new Date().toISOString(), status: "부분 완료", error_summary: "다음 일일 작업이 시작되어 이전 분석 대기 작업을 종료했습니다." }).in("status", ["실행 중", "분석 중"]);
  const { data: started, error: startError } = await admin.from("batch_runs").insert({}).select().single();
  if (startError || !started) throw startError ?? new Error("실행 이력을 만들 수 없습니다.");
  try {
    await ensureDefaultTopic();
    const collection = await runCollectionPass(new Date(String(started.started_at)));
    await admin.from("batch_runs").update({ status: "분석 중", discovered: collection.discovered, changed: collection.changed, api_calls: collection.queryCount, window_start: collection.windowStart, window_end: collection.windowEnd, window_hours: collection.windowHours }).eq("id", started.id);
    // A manual browser run may be closed before its continuation loop drains
    // the work. Publish the whole current queue so durable consumers can keep
    // processing independently of the browser tab.
    const queue = await enqueuePendingAttachmentJobs(5_000);
    const missingTextRequeued = await requeueAttachmentsMissingText(collection.noticeIds);
    const carriedScores = await carryForwardUnchangedScores(admin, collection.noticeIds, String(started.id));
    // Scope registration to this collection. Scanning the whole notice table
    // can consume the web request budget and leave current no-attachment
    // notices without a durable Gemini job.
    const aiQueue = await enqueueReadyNoticeAiJobs({ noticeIds: collection.noticeIds });
    // Web requests should return after collection and durable queue
    // registration. Attachment extraction and Gemini calls continue through
    // /api/runs/continue, avoiding a long initial request that can prevent the
    // admin page from starting its continuation loop.
    const result = { ...collection, ...queue, ...aiQueue, missingTextRequeued, carriedScores, inlineProcessed: 0, inlineAiProcessed: 0, analyzed: carriedScores };
    const { error: finishError } = await admin.from("batch_runs").update({
      // Queue registration is not analysis completion. The worker/continuation
      // must verify one Gemini score per collected notice before closing it.
      status: result.discovered ? "분석 중" : "완료", completed_at: result.discovered ? null : new Date().toISOString(), discovered: result.discovered,
      changed: result.changed, analyzed: result.analyzed, api_calls: result.queryCount,
      error_summary: result.discovered ? `첨부문서 ${queue.attachmentQueued}건, 공고 AI 분석 ${aiQueue.aiQueued}건을 대기열에 등록했습니다. 점수 확인 전까지 분석 중으로 유지합니다.` : null,
    }).eq("id", started.id);
    if (finishError) throw finishError;
    return { ...result, batchId: String(started.id), noticeIds: collection.noticeIds };
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
    const missingTextRequeued = await requeueAttachmentsMissingText(collection.noticeIds);
    const ocrRequeued = await requeueTraditionalOcrCandidates(collection.noticeIds);
    if (ocrRequeued) console.log(`[Batch] traditional OCR candidates requeued=${ocrRequeued}`);
    const carriedScores = await carryForwardUnchangedScores(admin, collection.noticeIds, String(started.id));
    // Never invent a score for an attachment-backed notice. It is published
    // only after every attachment is text-ready and Gemini succeeds. Notices
    // without attachments are already queued for Gemini title-only analysis.
    // A previous Vercel Queue consumer may still own a job for one of the
    // just-collected notices. The GitHub worker is the authoritative drain for
    // this run, so release those in-flight claims once before processing.
    await processPendingAttachmentJobsInline(0, false, undefined, collection.noticeIds, true);
    await processPendingNoticeAiJobsInline(0, undefined, collection.noticeIds, true);
    let attachmentProcessed = 0;
    let aiProcessed = 0;
    let idleCycles = 0;
    for (let cycle = 0; cycle < 1_000; cycle += 1) {
      console.log(`[Batch] cycle=${cycle + 1} attachmentProcessed=${attachmentProcessed} aiProcessed=${aiProcessed}`);
      // GitHub Actions is the authoritative drain for this run. Reclaim any
      // current-batch claims left by delayed Vercel Queue consumers before
      // each cycle so those claims cannot strand the daily snapshot.
      const cycleAttachmentProcessed = await processPendingAttachmentJobsInline(40, false, undefined, collection.noticeIds, true);
      const cycleAiProcessed = await processPendingNoticeAiJobsInline(4, undefined, collection.noticeIds, false, String(started.id));
      attachmentProcessed += cycleAttachmentProcessed;
      aiProcessed += cycleAiProcessed;
      const [pendingAttachments, pendingAi] = await Promise.all([
        countCurrentJobs(admin, "processing_jobs", collection.noticeIds, ["대기", "처리 중"], true),
        countCurrentJobs(admin, "notice_ai_jobs", collection.noticeIds, ["대기", "처리 중"]),
      ]);
      console.log(`[Batch] pending attachments=${pendingAttachments ?? 0} ai=${pendingAi ?? 0}`);
      if (pendingAttachments === 0 && pendingAi === 0) break;
      if (cycleAttachmentProcessed === 0 && cycleAiProcessed === 0) {
        idleCycles += 1;
        if (idleCycles >= 5) {
          console.warn(`[Batch] ${idleCycles}회 연속 진전이 없어 잔여 작업을 미완료로 종료합니다.`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      } else idleCycles = 0;
    }
    await finishActiveBatchIfDrained();
    const { data: analyzedRows, error: analyzedError } = await admin.from("topic_scores").select("id,analysis").gte("updated_at", String(started.started_at));
    if (analyzedError) throw analyzedError;
    const analyzed = (analyzedRows ?? []).filter((row: any) => String(row.analysis?.batchId ?? "") === String(started.id)).length;
    const [remainingAttachments, remainingAi, failedAttachments, failedAi] = await Promise.all([
      countCurrentJobs(admin, "processing_jobs", collection.noticeIds, ["대기", "처리 중"], true),
      countCurrentJobs(admin, "notice_ai_jobs", collection.noticeIds, ["대기", "처리 중"]),
      countCurrentJobs(admin, "processing_jobs", collection.noticeIds, ["실패"], true),
      countCurrentJobs(admin, "notice_ai_jobs", collection.noticeIds, ["실패"]),
    ]);
    // A drained queue is not the same as a completed analysis. Unsupported or
    // unextractable attachments are terminal, but the batch must remain
    // explicitly partial until every collected notice has a Gemini result.
    const drained = (remainingAttachments ?? 0) === 0 && (remainingAi ?? 0) === 0;
    const diagnostics = await currentBatchDiagnostics(admin, collection.noticeIds, String(started.id), String(started.started_at));
    const geminiAnalyzed = diagnostics.geminiAttachment + diagnostics.geminiTitleOnly;
    const complete = drained && !(failedAttachments || failedAi) && geminiAnalyzed === collection.discovered;
    const top = (values: Record<string, number>) => Object.entries(values).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => `${reason}(${count})`).join("·") || "없음";
    const errorSummary = complete ? null : `Gemini 분석 ${geminiAnalyzed}/${collection.discovered}건; 미완료 첨부 공고 ${diagnostics.attachmentNotReady}건·첨부 준비 후 Gemini 미실행 ${diagnostics.attachmentReadyWithoutGemini}건·첨부 없음 Gemini 미실행 ${diagnostics.noAttachmentWithoutGemini}건·quota 실패 ${diagnostics.quotaFailures}건·실패 첨부 ${failedAttachments}건·실패 AI ${failedAi}건; 첨부 상태 ${top(diagnostics.attachmentStatusSets)}; 첨부 사유 ${top(diagnostics.attachmentFailureReasons)}; AI 실패 사유 ${top(diagnostics.aiFailureReasons)}`;
    await admin.from("batch_runs").update({ status: complete ? "완료" : "부분 완료", completed_at: new Date().toISOString(), discovered: collection.discovered, changed: collection.changed, analyzed, api_calls: collection.queryCount, window_start: collection.windowStart, window_end: collection.windowEnd, window_hours: collection.windowHours, error_summary: errorSummary }).eq("id", started.id);
    console.log(`[Batch] diagnostics ${JSON.stringify(diagnostics)}`);
    return { ...collection, attachmentProcessed, aiProcessed, missingTextRequeued, carriedScores, analyzed, complete, drained, diagnostics };
  } catch (error) {
    await admin.from("batch_runs").update({ status: "부분 완료", completed_at: new Date().toISOString(), error_summary: error instanceof Error ? error.message : "작업자 실행 실패" }).eq("id", started.id);
    throw error;
  }
}
