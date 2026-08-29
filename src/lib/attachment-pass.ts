import { QueueClient } from "@vercel/queue";
import { createHash } from "node:crypto";
import { processAttachment } from "@/lib/attachment-processing";
import { enqueueNoticeAiWhenReady } from "@/lib/notice-ai-pass";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { Attachment } from "@/lib/types";

type Row = Record<string, any>;
export const ATTACHMENT_QUEUE_TOPIC = "bidfit-attachment";
export type AttachmentQueueMessage = { jobId: string };
// Do not pin recovery messages to an older deployment: a new extractor must
// always be consumed by the current Production route after a deployment.
const attachmentQueue = new QueueClient({ deploymentId: null });

/** Reclaim only scan-PDF results that Vercel could not OCR. */
export async function requeueTraditionalOcrCandidates(noticeIds: string[]) {
  if (process.env.OCR_ENABLED !== "true" || !noticeIds.length) return 0;
  const admin = createSupabaseAdminClient();
  const ids: string[] = [];
  for (let index = 0; index < noticeIds.length; index += 100) {
    const { data, error } = await admin.from("processing_jobs").select("id,attempts,attachments!inner(notice_id,name,status,failure_reason)").in("status", ["완료", "실패"]).in("attachments.notice_id", noticeIds.slice(index, index + 100));
    if (error) throw error;
    for (const row of data ?? []) {
      const attachment = Array.isArray((row as Row).attachments) ? (row as Row).attachments[0] : (row as Row).attachments;
      const name = String(attachment?.name ?? "").toLowerCase();
      const reason = String(attachment?.failure_reason ?? "");
      const attempts = Number((row as Row).attempts ?? 0);
      // Older runs exhausted the original five-attempt ceiling before the
      // HWPX/Office parsers and OCR fallback were improved. Allow a bounded
      // second recovery window for those same supported files.
      if (attempts >= 10) continue;
      const scanPdf = name.endsWith(".pdf") && String(attachment?.status ?? "") === "부분 분석" && /텍스트 레이어가 없는 PDF|텍스트를 추출하지 못했습니다/.test(reason);
      const newlySupportedOffice = /\.(docx|xlsx|pptx)$/.test(name) && String(attachment?.status ?? "") === "보류" && /PDF·HWP·HWPX만 현재 처리합니다|지원하지 않는 파일 형식/.test(reason);
      const legacySupportedExtraction = /\.(pdf|hwpx|hwp|docx|xlsx|pptx)$/.test(name) && /텍스트를 추출하지 못했습니다/.test(reason);
      const hwpBundleFailure = name.endsWith(".hwp") && /Cannot find module ['\"]cfb['\"]/.test(reason);
      const transientFailure = /operation was aborted due to timeout|Command failed: (tesseract|pdftoppm)/i.test(reason);
      if (scanPdf || newlySupportedOffice || legacySupportedExtraction || hwpBundleFailure || transientFailure) ids.push(String((row as Row).id));
    }
  }
  for (let index = 0; index < ids.length; index += 100) {
    const { error } = await admin.from("processing_jobs").update({ status: "대기", failure_reason: null, updated_at: new Date().toISOString() }).in("id", ids.slice(index, index + 100));
    if (error) throw error;
  }
  return ids.length;
}

/**
 * Early queue implementations could mark the job terminal before persisting
 * the attachment result. Recover only that inconsistent legacy state so it is
 * retried by the current extractor instead of remaining visibly pending.
 */
async function recoverPendingAttachmentsWithTerminalJobs() {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("processing_jobs")
    .select("id, attachments!inner(status,name,failure_reason)")
    .in("status", ["완료", "실패"])
    .limit(1_000);
  if (error) throw error;
  const ids = (data ?? []).filter((job: Row) => {
    const attachment = Array.isArray(job.attachments) ? job.attachments[0] : job.attachments;
    const status = String(attachment?.status ?? "");
    const name = String(attachment?.name ?? "").toLowerCase();
    const reason = String(attachment?.failure_reason ?? "");
    return status === "대기" || (name.endsWith(".hwp") && reason.includes("구형 HWP 텍스트 추출 HTTP 401"));
  }).map((job: Row) => String(job.id));
  if (!ids.length) return 0;
  // Supabase REST encodes `.in()` values in the request URL. Updating a large
  // legacy recovery set in one call can exceed undici's 16KB header limit.
  for (let index = 0; index < ids.length; index += 100) {
    const { error: updateError } = await admin
      .from("processing_jobs")
      .update({ status: "대기", failure_reason: null, updated_at: new Date().toISOString() })
      .in("id", ids.slice(index, index + 100));
    if (updateError) throw updateError;
  }
  return ids.length;
}

/** Publishes one durable queue message per unprocessed attachment. */
export async function enqueuePendingAttachmentJobs(limit = 200) {
  const admin = createSupabaseAdminClient();
  const staleBefore = new Date(Date.now() - 60_000).toISOString();
  await admin.from("processing_jobs").update({ status: "대기", updated_at: new Date().toISOString() }).eq("status", "처리 중").lt("updated_at", staleBefore);
  const recovered = await recoverPendingAttachmentsWithTerminalJobs();
  const { data: jobs, error } = await admin.from("processing_jobs").select("id,attempts").in("status", ["대기", "처리 중"]).order("created_at", { ascending: true }).limit(limit);
  if (error) throw error;
  const rows = jobs ?? [];
  for (let index = 0; index < rows.length; index += 25) {
    await Promise.all(rows.slice(index, index + 25).map((job: Row) => attachmentQueue.send<AttachmentQueueMessage>(ATTACHMENT_QUEUE_TOPIC, { jobId: String(job.id) }, { idempotencyKey: `extractor-v2:${String(job.id)}:${Number(job.attempts ?? 0)}`, retentionSeconds: 86_400 })));
  }
  return { attachmentQueued: rows.length, recovered };
}

/** Safety net for deployments where the hosted queue consumer is delayed. */
export async function processPendingAttachmentJobsInline(limit = 40, publishAiQueue = true, createdSince?: string, noticeIds?: string[], resetCurrentInFlight = false) {
  const admin = createSupabaseAdminClient();
  if (noticeIds?.length) {
    const staleBefore = new Date(Date.now() - 60_000).toISOString();
    for (let index = 0; index < noticeIds.length; index += 100) {
      let staleQuery = admin.from("processing_jobs").select("id,attachments!inner(notice_id)").eq("status", "처리 중").in("attachments.notice_id", noticeIds.slice(index, index + 100));
      if (!resetCurrentInFlight) staleQuery = staleQuery.lt("updated_at", staleBefore);
      const { data: stale, error } = await staleQuery;
      if (error) throw error;
      const ids = (stale ?? []).map((row: Row) => String(row.id));
      if (ids.length) {
        const { error: updateError } = await admin.from("processing_jobs").update({ status: "대기", updated_at: new Date().toISOString() }).in("id", ids);
        if (updateError) throw updateError;
      }
    }
  }
  let data: Row[] = [];
  if (noticeIds?.length) {
    for (let index = 0; index < noticeIds.length && data.length < limit; index += 100) {
      let partQuery = admin.from("processing_jobs").select("id,attachments!inner(notice_id)").in("status", resetCurrentInFlight ? ["대기", "처리 중"] : ["대기"]).in("attachments.notice_id", noticeIds.slice(index, index + 100)).order("created_at", { ascending: true }).limit(limit - data.length);
      const { data: part, error } = await partQuery;
      if (error) throw error;
      data.push(...(part ?? []));
    }
  } else {
    let query = admin.from("processing_jobs").select("id").eq("status", "대기").order("created_at", { ascending: true }).limit(limit);
    if (createdSince) query = query.gte("created_at", createdSince);
    const result = await query;
    data = result.data ?? [];
    if (result.error) throw result.error;
  }
  let processed = 0;
  for (let index = 0; index < (data ?? []).length; index += 8) {
    const group = (data ?? []).slice(index, index + 8);
    const results = await Promise.all(group.map(async (row) => {
      try { await processQueuedAttachmentJob(String(row.id), { publishAiQueue, allowInFlight: resetCurrentInFlight }); return 1; } catch (error) { const detail = error instanceof Error ? error.message : JSON.stringify(error); console.warn(`[Attachment] inline job ${String(row.id)} failed: ${detail}`); return 0; }
    }));
    processed += results.reduce<number>((sum, value) => sum + value, 0);
  }
  return processed;
}

/** Runs in an isolated Queue consumer invocation for exactly one attachment. */
export async function processQueuedAttachmentJob(jobId: string, options: { publishAiQueue?: boolean; allowInFlight?: boolean } = {}) {
  const admin = createSupabaseAdminClient();
  const { data: job, error } = await admin.from("processing_jobs").select("*, attachments(*)").eq("id", jobId).maybeSingle();
  if (error) throw error;
  if (!job) return { skipped: true, reason: "작업을 찾을 수 없습니다." };
  if (job.status === "완료" || job.status === "보류") return { skipped: true, reason: "이미 처리된 작업입니다." };
  const attachment = (Array.isArray(job.attachments) ? job.attachments[0] : job.attachments) as Row | undefined;
  if (!attachment) throw new Error("첨부파일 정보를 찾을 수 없습니다.");
  try {
    if (job.status !== "처리 중" || !options.allowInFlight) {
      const { data: claimed, error: claimError } = await admin.from("processing_jobs").update({ status: "처리 중", attempts: Number(job.attempts) + 1, updated_at: new Date().toISOString() }).eq("id", jobId).in("status", ["대기", "실패"]).select("id").maybeSingle();
      if (claimError) throw new Error(`첨부 작업 claim 실패: ${claimError.message}`);
      if (!claimed) return { skipped: true, reason: "다른 작업자가 이미 처리 중입니다." };
    }
    const processed = await processAttachment(String(attachment.notice_id), {
      id: String(attachment.id), name: String(attachment.name), kind: String(attachment.kind),
      status: String(attachment.status) as Attachment["status"], sourceUrl: String(attachment.source_url ?? ""),
    });
    // HWP extraction can contain NUL bytes. PostgreSQL text rejects them with
    // 22P05, which otherwise strands the processing job in "처리 중" forever.
    const extractedText = processed.extractedText?.replace(/\u0000/g, "");
    // Persist the text before declaring the attachment ready. A text-write
    // failure must not make the Gemini readiness gate see a false success.
    if (extractedText) {
      const { error: textError } = await admin.from("attachment_texts").upsert({ attachment_id: attachment.id, extracted_text: extractedText, page_map: [], extractor_version: "temporary-text-v1" });
      if (textError) throw new Error(`첨부 텍스트 저장 실패: ${textError.message}`);
    }
    const { error: attachmentError } = await admin.from("attachments").update({ status: processed.status, storage_path: null, pages: processed.pages ?? null, sha256: extractedText ? createHash("sha256").update(extractedText, "utf8").digest("hex") : null, failure_reason: processed.failureReason ?? null, updated_at: new Date().toISOString() }).eq("id", attachment.id);
    if (attachmentError) throw new Error(`첨부 상태 저장 실패: ${attachmentError.message}`);
    const terminal = processed.status === "분석 완료" || processed.status === "부분 분석" || processed.status === "보류";
    const { error: jobUpdateError } = await admin.from("processing_jobs").update({ status: terminal ? "완료" : "실패", failure_reason: processed.failureReason ?? null, updated_at: new Date().toISOString() }).eq("id", jobId);
    if (jobUpdateError) throw new Error(`첨부 작업 완료 상태 저장 실패: ${jobUpdateError.message}`);
    const ai = await enqueueNoticeAiWhenReady(String(attachment.notice_id), 0, options.publishAiQueue ?? true);
    await finishActiveBatchIfDrained();
    return { skipped: false, attachmentStatus: processed.status, aiQueued: ai.queued };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "첨부파일 처리 중 알 수 없는 오류";
    // A failed persistence step previously left the claimed job in "처리 중"
    // forever, which made every GitHub Actions retry stall on the same file.
    await admin.from("attachments").update({ status: "추출 실패", failure_reason: reason, updated_at: new Date().toISOString() }).eq("id", attachment.id);
    await admin.from("processing_jobs").update({ status: "실패", failure_reason: reason, updated_at: new Date().toISOString() }).eq("id", jobId);
    await finishActiveBatchIfDrained();
    throw cause;
  }
}

export async function finishActiveBatchIfDrained() {
  const admin = createSupabaseAdminClient();
  const { data: active } = await admin.from("batch_runs").select("id,started_at,discovered").eq("status", "분석 중").order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (!active) return;
  const { count: attachmentCount, error } = await admin.from("processing_jobs").select("id", { count: "exact", head: true }).in("status", ["대기", "처리 중"]);
  const { count: aiCount, error: aiError } = await admin.from("notice_ai_jobs").select("id", { count: "exact", head: true }).in("status", ["대기", "처리 중"]);
  // Legacy jobs from prior runs must not block completion of the current run.
  const { count: currentAttachments } = await admin.from("processing_jobs").select("id", { count: "exact", head: true }).in("status", ["대기", "처리 중"]).gte("created_at", active.started_at);
  const { count: currentAi } = await admin.from("notice_ai_jobs").select("id", { count: "exact", head: true }).in("status", ["대기", "처리 중"]).gte("created_at", active.started_at);
  if (error || aiError || (currentAttachments ?? 0) > 0 || (currentAi ?? 0) > 0) return;
  const { data: scores } = await admin.from("topic_scores").select("notice_id,analysis").gte("updated_at", active.started_at);
  const analyzed = new Set((scores ?? []).filter((row: any) => String(row.analysis?.batchId ?? "") === String(active.id) && String(row.analysis?.aiModel ?? "").toLowerCase().startsWith("gemini")).map((row: any) => String(row.notice_id))).size;
  const complete = Number(active.discovered ?? 0) > 0 && analyzed === Number(active.discovered);
  let errorSummary: string | null = null;
  if (!complete) {
    const { data: notices } = await admin.from("notices").select("attachments(status,failure_reason)").gte("updated_at", active.started_at);
    const statusCounts: Record<string, number> = {};
    const reasonCounts: Record<string, number> = {};
    for (const notice of notices ?? []) {
      for (const attachment of (notice as Row).attachments ?? []) {
        const status = String(attachment.status ?? "사유 미기록");
        if (status === "분석 완료") continue;
        statusCounts[status] = (statusCounts[status] ?? 0) + 1;
        const reason = String(attachment.failure_reason ?? "사유 미기록");
        reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
      }
    }
    const top = (values: Record<string, number>) => Object.entries(values).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => `${reason}(${count})`).join("·") || "없음";
    errorSummary = `Gemini 분석 ${analyzed}/${Number(active.discovered ?? 0)}건; 첨부 상태 ${top(statusCounts)}; 첨부 사유 ${top(reasonCounts)}`;
  }
  await admin.from("batch_runs").update({ status: complete ? "완료" : "부분 완료", completed_at: new Date().toISOString(), analyzed, error_summary: errorSummary }).eq("id", active.id);
}
