import { enqueuePendingAttachmentJobs, finishActiveBatchIfDrained, processPendingAttachmentJobsInline } from "@/lib/attachment-pass";
import { runCollectionPass } from "@/lib/collection-pass";
import { enqueueReadyNoticeAiJobs, processPendingNoticeAiJobsInline } from "@/lib/notice-ai-pass";
import { ensureDefaultTopic } from "@/lib/repository";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { AnalysisResult, Topic } from "@/lib/types";

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

const topicFromRow = (row: any): Topic => ({
  id: String(row.id), name: String(row.name), description: String(row.description ?? ""), capabilities: String(row.capabilities ?? ""),
  includeKeywords: Array.isArray(row.include_keywords) ? row.include_keywords.map(String) : [],
  excludeKeywords: Array.isArray(row.exclude_keywords) ? row.exclude_keywords.map(String) : [],
  businessTypes: Array.isArray(row.business_types) ? row.business_types : ["용역"],
  regions: Array.isArray(row.regions) ? row.regions.map(String) : [],
  minBudget: row.min_budget == null ? null : Number(row.min_budget), maxBudget: row.max_budget == null ? null : Number(row.max_budget),
  minimumDays: Number(row.minimum_days ?? 0), threshold: Number(row.threshold ?? 70),
});

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
      if (!analysis || typeof analysis.aiModel !== "string" || String(analysis.sourceHash ?? "") !== hashByNotice.get(String(score.notice_id))) continue;
      if (String(analysis.batchId ?? "") === batchId) continue;
      const { error } = await admin.from("topic_scores").update({ analysis: { ...analysis, batchId }, updated_at: new Date().toISOString() }).eq("id", score.id);
      if (error) throw error;
      carried += 1;
    }
  }
  return carried;
}

function quotaFallbackAnalysis(notice: any, topic: Topic, batchId: string): AnalysisResult & { sourceHash: string; batchId: string } {
  const text = `${String(notice.title ?? "")} ${String(notice.description ?? "")} ${Array.isArray(notice.tasks) ? notice.tasks.join(" ") : ""}`.toLowerCase();
  const include = [...topic.includeKeywords, ...topic.name.split(/[\s·,()/]+/)].map((keyword) => keyword.trim().toLowerCase()).filter((keyword) => keyword.length >= 2);
  const exclude = topic.excludeKeywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean);
  const matched = include.filter((keyword) => text.includes(keyword));
  const excluded = exclude.some((keyword) => text.includes(keyword));
  // Preserve Gemini capacity for attachment-backed evidence. This transparent
  // fallback makes every collected service notice comparable, but never grants
  // a high-confidence recommendation without Gemini/document evidence.
  const score = excluded ? 0 : Math.min(60, matched.length * 20);
  return {
    score,
    grade: score >= 50 ? "보통" : "낮음",
    confidence: "낮음",
    eligibilityStatus: "확인 필요",
    summary: matched.length ? `공고명·설명에서 관심 주제 관련 표현(${matched.join(", ")})을 확인했습니다. 첨부문서 근거는 아직 반영되지 않았습니다.` : "공고명·설명에서 관심 주제와의 직접적인 관련 표현을 확인하지 못했습니다.",
    components: [{ name: "공고명·설명 보조 점수", score, maxScore: 100 }],
    positiveReasons: [{ label: "Gemini 할당량 보존용 보조 분석", text: matched.length ? `일치 표현: ${matched.join(", ")}` : "직접 일치 표현 없음", source: "공고명·공고 설명", location: "자동 선별" }],
    penalties: excluded ? ["제외 키워드가 공고명 또는 설명에서 확인되었습니다."] : [],
    uncertainties: ["Gemini·첨부문서 분석 전의 낮은 신뢰도 보조 점수입니다."],
    aiModel: "rule-based-quota-fallback",
    promptVersion: "notice-fallback-v2",
    sourceHash: String(notice.source_hash ?? ""),
    batchId,
  };
}

async function fillQuotaFallbackScores(admin: any, noticeIds: string[], batchId: string) {
  const { data: topics, error: topicsError } = await admin.from("topics").select("*").limit(10);
  if (topicsError) throw topicsError;
  let created = 0;
  for (let index = 0; index < noticeIds.length; index += 100) {
    const ids = noticeIds.slice(index, index + 100);
    const [{ data: notices, error: noticesError }, { data: scores, error: scoresError }] = await Promise.all([
      admin.from("notices").select("id,title,description,tasks,source_hash").in("id", ids),
      admin.from("topic_scores").select("topic_id,notice_id,analysis").in("notice_id", ids),
    ]);
    if (noticesError) throw noticesError;
    if (scoresError) throw scoresError;
    for (const topicRow of topics ?? []) {
      const topic = topicFromRow(topicRow);
      const rows = (notices ?? []).filter((notice: any) => {
        const score = (scores ?? []).find((candidate: any) => String(candidate.topic_id) === String(topic.id) && String(candidate.notice_id) === String(notice.id));
        const analysis = score?.analysis as Record<string, unknown> | undefined;
        return !analysis || String(analysis.sourceHash ?? "") !== String(notice.source_hash ?? "");
      }).map((notice: any) => {
        const analysis = quotaFallbackAnalysis(notice, topic, batchId);
        return { topic_id: topic.id, notice_id: notice.id, analysis, score: analysis.score, updated_at: new Date().toISOString() };
      });
      if (!rows.length) continue;
      const { error } = await admin.from("topic_scores").upsert(rows, { onConflict: "topic_id,notice_id" });
      if (error) throw error;
      created += rows.length;
    }
  }
  return created;
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
    const inlineAiProcessed = await processPendingNoticeAiJobsInline(8, undefined, undefined, false, String(started.id));
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
    const carriedScores = await carryForwardUnchangedScores(admin, collection.noticeIds, String(started.id));
    const fallbackScores = await fillQuotaFallbackScores(admin, collection.noticeIds, String(started.id));
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
    // Failed/unsupported documents are terminal and must not hide scores that
    // were successfully produced for the same analysis window. Only work that
    // is still pending prevents the public snapshot from being published.
    const complete = (remainingAttachments ?? 0) === 0 && (remainingAi ?? 0) === 0;
    const errorSummary = complete && !(failedAttachments || failedAi) ? null : `일부 처리 제외: 실패 첨부 ${failedAttachments}건·실패 AI ${failedAi}건`;
    await admin.from("batch_runs").update({ status: complete ? "완료" : "부분 완료", completed_at: new Date().toISOString(), discovered: collection.discovered, changed: collection.changed, analyzed, api_calls: collection.queryCount, window_start: collection.windowStart, window_end: collection.windowEnd, window_hours: collection.windowHours, error_summary: errorSummary }).eq("id", started.id);
    return { ...collection, attachmentProcessed, aiProcessed, carriedScores, fallbackScores, analyzed, complete };
  } catch (error) {
    await admin.from("batch_runs").update({ status: "부분 완료", completed_at: new Date().toISOString(), error_summary: error instanceof Error ? error.message : "작업자 실행 실패" }).eq("id", started.id);
    throw error;
  }
}
