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
export async function processPendingAttachmentJobsInline(limit = 40, publishAiQueue = true) {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.from("processing_jobs").select("id").eq("status", "대기").order("created_at", { ascending: true }).limit(limit);
  if (error) throw error;
  let processed = 0;
  for (let index = 0; index < (data ?? []).length; index += 8) {
    const group = (data ?? []).slice(index, index + 8);
    const results = await Promise.all(group.map(async (row) => {
      try { await processQueuedAttachmentJob(String(row.id), { publishAiQueue }); return 1; } catch { return 0; }
    }));
    processed += results.reduce<number>((sum, value) => sum + value, 0);
  }
  return processed;
}

/** Runs in an isolated Queue consumer invocation for exactly one attachment. */
export async function processQueuedAttachmentJob(jobId: string, options: { publishAiQueue?: boolean } = {}) {
  const admin = createSupabaseAdminClient();
  const { data: job, error } = await admin.from("processing_jobs").select("*, attachments(*)").eq("id", jobId).maybeSingle();
  if (error) throw error;
  if (!job) return { skipped: true, reason: "작업을 찾을 수 없습니다." };
  if (job.status === "완료" || job.status === "보류" || job.status === "처리 중") return { skipped: true, reason: "이미 처리된 작업입니다." };
  const attachment = job.attachments as Row | undefined;
  if (!attachment) throw new Error("첨부파일 정보를 찾을 수 없습니다.");

  const { data: claimed, error: claimError } = await admin.from("processing_jobs").update({ status: "처리 중", attempts: Number(job.attempts) + 1, updated_at: new Date().toISOString() }).eq("id", jobId).in("status", ["대기", "실패"]).select("id").maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return { skipped: true, reason: "다른 작업자가 이미 처리 중입니다." };
  const processed = await processAttachment(String(attachment.notice_id), {
    id: String(attachment.id), name: String(attachment.name), kind: String(attachment.kind),
    status: String(attachment.status) as Attachment["status"], sourceUrl: String(attachment.source_url ?? ""),
  });
  await admin.from("attachments").update({ status: processed.status, storage_path: null, pages: processed.pages ?? null, sha256: processed.extractedText ? createHash("sha256").update(processed.extractedText, "utf8").digest("hex") : null, failure_reason: processed.failureReason ?? null, updated_at: new Date().toISOString() }).eq("id", attachment.id);
  if (processed.extractedText) {
    const { error: textError } = await admin.from("attachment_texts").upsert({ attachment_id: attachment.id, extracted_text: processed.extractedText, page_map: [], extractor_version: "temporary-text-v1" });
    if (textError) throw textError;
  }
  const terminal = processed.status === "분석 완료" || processed.status === "부분 분석" || processed.status === "보류";
  await admin.from("processing_jobs").update({ status: terminal ? "완료" : "실패", failure_reason: processed.failureReason ?? null, updated_at: new Date().toISOString() }).eq("id", jobId);
  const ai = await enqueueNoticeAiWhenReady(String(attachment.notice_id), 0, options.publishAiQueue ?? true);
  await finishActiveBatchIfDrained();
  return { skipped: false, attachmentStatus: processed.status, aiQueued: ai.queued };
}

export async function finishActiveBatchIfDrained() {
  const admin = createSupabaseAdminClient();
  const { data: active } = await admin.from("batch_runs").select("id,started_at").eq("status", "분석 중").order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (!active) return;
  const { count: attachmentCount, error } = await admin.from("processing_jobs").select("id", { count: "exact", head: true }).in("status", ["대기", "처리 중"]);
  const { count: aiCount, error: aiError } = await admin.from("notice_ai_jobs").select("id", { count: "exact", head: true }).in("status", ["대기", "처리 중"]);
  // Legacy jobs from prior runs must not block completion of the current run.
  const { count: currentAttachments } = await admin.from("processing_jobs").select("id", { count: "exact", head: true }).in("status", ["대기", "처리 중"]).gte("created_at", active.started_at);
  const { count: currentAi } = await admin.from("notice_ai_jobs").select("id", { count: "exact", head: true }).in("status", ["대기", "처리 중"]).gte("created_at", active.started_at);
  if (error || aiError || (currentAttachments ?? 0) > 0 || (currentAi ?? 0) > 0) return;
  const { count: analyzed } = await admin.from("topic_scores").select("id", { count: "exact", head: true }).gte("updated_at", active.started_at);
  await admin.from("batch_runs").update({ status: "완료", completed_at: new Date().toISOString(), analyzed: analyzed ?? 0, error_summary: null }).eq("id", active.id);
}
