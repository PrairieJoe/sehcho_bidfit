import { processAttachment } from "@/lib/attachment-processing";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { Attachment } from "@/lib/types";

type Row = Record<string, any>;
const normalize = (value: string) => value.toLowerCase().replace(/\s/g, "");
const MAX_PER_BATCH = 3;

/** Processes a small, title-matched attachment queue within the Vercel Hobby budget. */
export async function runAttachmentPass() {
  const admin = createSupabaseAdminClient();
  const { data: topics, error: topicError } = await admin.from("topics").select("include_keywords").limit(10);
  if (topicError) throw topicError;
  const keywords = [...new Set((topics ?? []).flatMap((topic) => Array.isArray(topic.include_keywords) ? topic.include_keywords.map(String) : []))];
  const { data: jobs, error: jobError } = await admin.from("processing_jobs").select("*, attachments(*, notices(title))").in("status", ["대기", "처리 중"]).lte("run_after", new Date().toISOString()).limit(30);
  if (jobError) throw jobError;
  const candidates = (jobs ?? []).filter((job: Row) => {
    const title = String((job.attachments as Row | undefined)?.notices?.title ?? "");
    return keywords.some((keyword) => normalize(title).includes(normalize(keyword)));
  }).slice(0, MAX_PER_BATCH);

  let completed = 0;
  for (const job of candidates) {
    const attachment = job.attachments as Row | undefined;
    if (!attachment) continue;
    await admin.from("processing_jobs").update({ status: "처리 중", attempts: Number(job.attempts) + 1, updated_at: new Date().toISOString() }).eq("id", job.id);
    const processed = await processAttachment(String(attachment.notice_id), { id: String(attachment.id), name: String(attachment.name), kind: String(attachment.kind), status: String(attachment.status) as Attachment["status"], sourceUrl: String(attachment.source_url ?? "") });
    await admin.from("attachments").update({ status: processed.status, storage_path: processed.storagePath ?? null, pages: processed.pages ?? null, failure_reason: processed.failureReason ?? null, updated_at: new Date().toISOString() }).eq("id", attachment.id);
    if (processed.extractedText) await admin.from("attachment_texts").upsert({ attachment_id: attachment.id, extracted_text: processed.extractedText, page_map: [], extractor_version: "keyword-v1" });
    await admin.from("processing_jobs").update({ status: processed.status === "분석 완료" || processed.status === "부분 분석" || processed.status === "보류" ? "완료" : "실패", failure_reason: processed.failureReason ?? null, updated_at: new Date().toISOString() }).eq("id", job.id);
    completed += 1;
  }
  return { attachmentProcessed: completed, attachmentCandidates: candidates.length };
}
