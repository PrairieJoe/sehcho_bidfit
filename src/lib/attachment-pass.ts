import { send } from "@vercel/queue";
import { createHash } from "node:crypto";
import { processAttachment } from "@/lib/attachment-processing";
import { enqueueNoticeAiWhenReady } from "@/lib/notice-ai-pass";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { Attachment } from "@/lib/types";

type Row = Record<string, any>;
export const ATTACHMENT_QUEUE_TOPIC = "bidfit-attachment";
export type AttachmentQueueMessage = { jobId: string };

/**
 * Early queue implementations could mark the job terminal before persisting
 * the attachment result. Recover only that inconsistent legacy state so it is
 * retried by the current extractor instead of remaining visibly pending.
 */
async function recoverPendingAttachmentsWithTerminalJobs() {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("processing_jobs")
    .select("id, attachments!inner(status)")
    .in("status", ["완료", "실패"])
    .eq("attachments.status", "대기")
    .limit(1_000);
  if (error) throw error;
  const ids = (data ?? []).map((job: Row) => String(job.id));
  if (!ids.length) return 0;
  const { error: updateError } = await admin
    .from("processing_jobs")
    .update({ status: "대기", failure_reason: null, updated_at: new Date().toISOString() })
    .in("id", ids);
  if (updateError) throw updateError;
  return ids.length;
}

/** Publishes one durable queue message per unprocessed attachment. */
export async function enqueuePendingAttachmentJobs() {
  const admin = createSupabaseAdminClient();
  const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
  await admin.from("processing_jobs").update({ status: "대기", updated_at: new Date().toISOString() }).eq("status", "처리 중").lt("updated_at", staleBefore);
  const recovered = await recoverPendingAttachmentsWithTerminalJobs();
  const { data: jobs, error } = await admin.from("processing_jobs").select("id,attempts").in("status", ["대기", "처리 중"]).order("created_at", { ascending: true }).limit(1000);
  if (error) throw error;
  const rows = jobs ?? [];
  for (let index = 0; index < rows.length; index += 25) {
    await Promise.all(rows.slice(index, index + 25).map((job: Row) => send<AttachmentQueueMessage>(ATTACHMENT_QUEUE_TOPIC, { jobId: String(job.id) }, { idempotencyKey: `${String(job.id)}:${Number(job.attempts ?? 0)}`, retentionSeconds: 86_400 })));
  }
  return { attachmentQueued: rows.length, recovered };
}

/** Runs in an isolated Queue consumer invocation for exactly one attachment. */
export async function processQueuedAttachmentJob(jobId: string) {
  const admin = createSupabaseAdminClient();
  const { data: job, error } = await admin.from("processing_jobs").select("*, attachments(*)").eq("id", jobId).maybeSingle();
  if (error) throw error;
  if (!job) return { skipped: true, reason: "작업을 찾을 수 없습니다." };
  if (job.status === "완료" || job.status === "보류") return { skipped: true, reason: "이미 처리된 작업입니다." };
  const attachment = job.attachments as Row | undefined;
  if (!attachment) throw new Error("첨부파일 정보를 찾을 수 없습니다.");

  await admin.from("processing_jobs").update({ status: "처리 중", attempts: Number(job.attempts) + 1, updated_at: new Date().toISOString() }).eq("id", jobId);
  const processed = await processAttachment(String(attachment.notice_id), {
    id: String(attachment.id), name: String(attachment.name), kind: String(attachment.kind),
    status: String(attachment.status) as Attachment["status"], sourceUrl: String(attachment.source_url ?? ""),
  });
  await admin.from("attachments").update({ status: processed.status, storage_path: null, pages: processed.pages ?? null, sha256: processed.extractedText ? createHash("sha256").update(processed.extractedText, "utf8").digest("hex") : null, failure_reason: processed.failureReason ?? null, updated_at: new Date().toISOString() }).eq("id", attachment.id);
  if (processed.extractedText) await admin.from("attachment_texts").upsert({ attachment_id: attachment.id, extracted_text: processed.extractedText, page_map: [], extractor_version: "temporary-text-v1" });
  const terminal = processed.status === "분석 완료" || processed.status === "부분 분석" || processed.status === "보류";
  await admin.from("processing_jobs").update({ status: terminal ? "완료" : "실패", failure_reason: processed.failureReason ?? null, updated_at: new Date().toISOString() }).eq("id", jobId);
  const ai = await enqueueNoticeAiWhenReady(String(attachment.notice_id));
  await finishActiveBatchIfDrained();
  return { skipped: false, attachmentStatus: processed.status, aiQueued: ai.queued };
}

export async function finishActiveBatchIfDrained() {
  const admin = createSupabaseAdminClient();
  const { count: attachmentCount, error } = await admin.from("processing_jobs").select("id", { count: "exact", head: true }).in("status", ["대기", "처리 중"]);
  const { count: aiCount, error: aiError } = await admin.from("notice_ai_jobs").select("id", { count: "exact", head: true }).in("status", ["대기", "처리 중"]);
  if (error || aiError || (attachmentCount ?? 0) > 0 || (aiCount ?? 0) > 0) return;
  const { data: active } = await admin.from("batch_runs").select("id,started_at").eq("status", "분석 중").order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (!active) return;
  const { count: analyzed } = await admin.from("topic_scores").select("id", { count: "exact", head: true }).gte("updated_at", active.started_at);
  await admin.from("batch_runs").update({ status: "완료", completed_at: new Date().toISOString(), analyzed: analyzed ?? 0, error_summary: null }).eq("id", active.id);
}
