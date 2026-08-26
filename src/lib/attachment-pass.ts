import { processAttachment } from "@/lib/attachment-processing";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { Attachment } from "@/lib/types";

type Row = Record<string, any>;
// Vercel Hobby의 5분 함수 한도보다 여유를 둔다. 시간 안에 처리하지 못한
// 파일은 처리 작업으로 남아 다음 정기 실행에서 이어서 처리한다.
const PROCESSING_BUDGET_MS = 250_000;
const MAX_QUEUE_SCAN = 500;

/**
 * Processes attachments sequentially. A notice title is never used to exclude its
 * documents: the business substance is determined from extracted document text.
 */
export async function runAttachmentPass(noticeIds?: string[]) {
  const admin = createSupabaseAdminClient();
  const { data: jobs, error: jobError } = await admin.from("processing_jobs").select("*, attachments(*)").in("status", ["대기", "처리 중"]).lte("run_after", new Date().toISOString()).order("updated_at", { ascending: true }).limit(MAX_QUEUE_SCAN);
  if (jobError) throw jobError;
  const candidates = (jobs ?? []).filter((job: Row) => !noticeIds || noticeIds.includes(String((job.attachments as Row | undefined)?.notice_id ?? "")));

  let completed = 0;
  const startedAt = Date.now();
  for (const job of candidates) {
    if (Date.now() - startedAt >= PROCESSING_BUDGET_MS) break;
    const attachment = job.attachments as Row | undefined;
    if (!attachment) continue;
    await admin.from("processing_jobs").update({ status: "처리 중", attempts: Number(job.attempts) + 1, updated_at: new Date().toISOString() }).eq("id", job.id);
    const processed = await processAttachment(String(attachment.notice_id), { id: String(attachment.id), name: String(attachment.name), kind: String(attachment.kind), status: String(attachment.status) as Attachment["status"], sourceUrl: String(attachment.source_url ?? "") });
    await admin.from("attachments").update({ status: processed.status, storage_path: processed.storagePath ?? null, pages: processed.pages ?? null, failure_reason: processed.failureReason ?? null, updated_at: new Date().toISOString() }).eq("id", attachment.id);
    if (processed.extractedText) await admin.from("attachment_texts").upsert({ attachment_id: attachment.id, extracted_text: processed.extractedText, page_map: [], extractor_version: "keyword-v1" });
    await admin.from("processing_jobs").update({ status: processed.status === "분석 완료" || processed.status === "부분 분석" || processed.status === "보류" ? "완료" : "실패", failure_reason: processed.failureReason ?? null, updated_at: new Date().toISOString() }).eq("id", job.id);
    completed += 1;
  }
  return { attachmentProcessed: completed, attachmentCandidates: candidates.length, pending: Math.max(0, candidates.length - completed) };
}
