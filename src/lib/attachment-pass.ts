import { send } from "@vercel/queue";
import { runAnalysisPass } from "@/lib/analysis-pass";
import { processAttachment } from "@/lib/attachment-processing";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { Attachment } from "@/lib/types";

type Row = Record<string, any>;
export const ATTACHMENT_QUEUE_TOPIC = "bidfit-attachment";
export type AttachmentQueueMessage = { jobId: string };

/** Publishes one durable queue message per unprocessed attachment. */
export async function enqueuePendingAttachmentJobs() {
  const admin = createSupabaseAdminClient();
  const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
  await admin.from("processing_jobs").update({ status: "대기", updated_at: new Date().toISOString() }).eq("status", "처리 중").lt("updated_at", staleBefore);
  const { data: jobs, error } = await admin.from("processing_jobs").select("id").in("status", ["대기", "처리 중"]).order("created_at", { ascending: true }).limit(1000);
  if (error) throw error;
  const rows = jobs ?? [];
  for (let index = 0; index < rows.length; index += 25) {
    await Promise.all(rows.slice(index, index + 25).map((job: Row) => send<AttachmentQueueMessage>(ATTACHMENT_QUEUE_TOPIC, { jobId: String(job.id) }, { idempotencyKey: String(job.id), retentionSeconds: 86_400 })));
  }
  return { attachmentQueued: rows.length };
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
  await admin.from("attachments").update({ status: processed.status, storage_path: null, pages: processed.pages ?? null, failure_reason: processed.failureReason ?? null, updated_at: new Date().toISOString() }).eq("id", attachment.id);
  if (processed.extractedText) await admin.from("attachment_texts").upsert({ attachment_id: attachment.id, extracted_text: processed.extractedText, page_map: [], extractor_version: "keyword-v1" });
  const terminal = processed.status === "분석 완료" || processed.status === "부분 분석" || processed.status === "보류";
  await admin.from("processing_jobs").update({ status: terminal ? "완료" : "실패", failure_reason: processed.failureReason ?? null, updated_at: new Date().toISOString() }).eq("id", jobId);
  const analysis = await runAnalysisPass([String(attachment.notice_id)]);
  await finishActiveBatchIfDrained();
  return { skipped: false, attachmentStatus: processed.status, analyzed: analysis.analyzed };
}

async function finishActiveBatchIfDrained() {
  const admin = createSupabaseAdminClient();
  const { count, error } = await admin.from("processing_jobs").select("id", { count: "exact", head: true }).in("status", ["대기", "처리 중"]);
  if (error || (count ?? 0) > 0) return;
  const { data: active } = await admin.from("batch_runs").select("id,started_at").eq("status", "분석 중").order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (!active) return;
  const { count: analyzed } = await admin.from("topic_scores").select("id", { count: "exact", head: true }).gte("updated_at", active.started_at);
  await admin.from("batch_runs").update({ status: "완료", completed_at: new Date().toISOString(), analyzed: analyzed ?? 0, error_summary: null }).eq("id", active.id);
}
