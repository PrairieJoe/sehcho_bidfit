import { createHash } from "node:crypto";
import { send } from "@vercel/queue";
import { finishActiveBatchIfDrained } from "@/lib/attachment-pass";
import { analyzeWithGemini } from "@/lib/gemini";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { BidNotice, Topic } from "@/lib/types";

type Row = Record<string, any>;
const list = (value: unknown) => Array.isArray(value) ? value.map(String) : [];
export const NOTICE_AI_QUEUE_TOPIC = "bidfit-notice-ai";
export type NoticeAiQueueMessage = { aiJobId: string };
const topicOf = (row: Row): Topic => ({ id: String(row.id), name: String(row.name), description: String(row.description ?? ""), capabilities: String(row.capabilities ?? ""), includeKeywords: list(row.include_keywords), excludeKeywords: list(row.exclude_keywords), businessTypes: list(row.business_types) as Topic["businessTypes"], regions: list(row.regions), minBudget: row.min_budget == null ? null : Number(row.min_budget), maxBudget: row.max_budget == null ? null : Number(row.max_budget), minimumDays: Number(row.minimum_days ?? 0), threshold: Number(row.threshold ?? 70) });
const noticeOf = (row: Row): BidNotice => ({ id: String(row.id), bidNumber: String(row.bid_number), order: String(row.bid_order), title: String(row.title), businessType: String(row.business_type) as BidNotice["businessType"], status: String(row.status) as BidNotice["status"], agency: String(row.agency), demandAgency: String(row.demand_agency), region: String(row.region), publishedAt: String(row.published_at ?? ""), closesAt: String(row.closes_at ?? ""), budget: row.budget == null ? null : Number(row.budget), budgetLabel: String(row.budget_label), contractMethod: String(row.contract_method), detailUrl: String(row.detail_url), description: String(row.description), tasks: list(row.tasks), qualifications: list(row.qualifications), attachments: (row.attachments ?? []).map((item: Row) => ({ id: String(item.id), name: String(item.name), kind: String(item.kind), status: String(item.status) as BidNotice["attachments"][number]["status"], extractedText: String((Array.isArray(item.attachment_texts) ? item.attachment_texts[0] : item.attachment_texts)?.extracted_text ?? "") || undefined })), reviewState: "검토 전" });

export async function enqueueNoticeAiWhenReady(noticeId: string, delaySeconds = 0, publish = true) {
  // A missing key must never silently produce a keyword-based score.
  if (!process.env.GEMINI_API_KEY) return { queued: false, reason: "Gemini API 키가 설정되지 않았습니다." };
  const admin = createSupabaseAdminClient();
  const { data: attachments, error } = await admin.from("attachments").select("id,status,sha256,attachment_texts(extracted_text)").eq("notice_id", noticeId);
  if (error) throw error;
  const rows = attachments ?? [];
  const { data: noticeMeta, error: noticeMetaError } = await admin.from("notices").select("title,description").eq("id", noticeId).maybeSingle();
  if (noticeMetaError) throw noticeMetaError;
  const completedRows = rows.filter((item: Row) => item.status === "분석 완료");
  const textRows = completedRows.filter((item: Row) => String((Array.isArray(item.attachment_texts) ? item.attachment_texts[0] : item.attachment_texts)?.extracted_text ?? "").trim());
  // An attachment may retain its terminal status after its text was deleted
  // following a completed analysis. Never enqueue an AI job for that stale
  // state: it would only produce "추출 텍스트가 없습니다" on every run.
  const allAttachmentsReady = rows.length === 0 || textRows.length === rows.length;
  if (!allAttachmentsReady || rows.some((item: Row) => item.status === "대기" || item.status === "처리 중")) {
    if (!allAttachmentsReady) {
      await admin.from("notice_ai_jobs").update({ status: "실패", failure_reason: "모든 첨부문서의 텍스트 추출이 끝나지 않아 Gemini 분석을 건너뛰었습니다.", updated_at: new Date().toISOString() }).eq("notice_id", noticeId).in("status", ["대기", "실패"]);
    }
    return { queued: false, reason: allAttachmentsReady ? "첨부문서 처리가 아직 끝나지 않았습니다." : "모든 첨부문서의 텍스트 추출이 완료되지 않았습니다." };
  }
  const analyzerVersion = `gemini:${process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite"}`;
  const inputHash = createHash("sha256").update(`${analyzerVersion}|${String(noticeMeta?.title ?? "")}|${String(noticeMeta?.description ?? "")}|${rows.map((item: Row) => `${item.id}:${item.sha256 ?? ""}:${String((Array.isArray(item.attachment_texts) ? item.attachment_texts[0] : item.attachment_texts)?.extracted_text ?? "").length}`).sort().join("|")}`, "utf8").digest("hex");
  const { data: inserted, error: jobError } = await admin.from("notice_ai_jobs").upsert({ notice_id: noticeId, input_hash: inputHash, status: "대기" }, { onConflict: "notice_id,input_hash", ignoreDuplicates: true }).select("id,status").maybeSingle();
  if (jobError) throw jobError;
  const job = inserted ?? (await admin.from("notice_ai_jobs").select("id,status").eq("notice_id", noticeId).eq("input_hash", inputHash).maybeSingle()).data;
  if (!job || job.status === "완료") return { queued: false };
  if (publish) await send<NoticeAiQueueMessage>(NOTICE_AI_QUEUE_TOPIC, { aiJobId: String(job.id) }, { idempotencyKey: `${noticeId}:${inputHash}`, retentionSeconds: 86_400, delaySeconds });
  return { queued: true };
}

/** Enqueues old, already-extracted notices after an AI key or model is newly configured. */
export async function enqueueReadyNoticeAiJobs(options: { publish?: boolean; noticeIds?: string[] } = {}) {
  const admin = createSupabaseAdminClient();
  // Analyze every collected notice. Attachment-backed notices wait until all
  // supported files have extracted text; notices without attachments use the
  // explicit title/description fallback in analyzeWithGemini. The previous
  // attachment-only scan silently excluded no-attachment notices and made the
  // dashboard report a misleading zero.
  let query = admin.from("notices").select("id,attachments(id,status,attachment_texts(extracted_text))").order("updated_at", { ascending: false }).limit(5_000);
  if (options.noticeIds?.length) query = query.in("id", options.noticeIds);
  const { data, error } = await query;
  if (error) throw error;
  const noticeIds = (data ?? []).filter((row: Row) => {
    const attachments = Array.isArray(row.attachments) ? row.attachments : [];
    return attachments.length === 0 || attachments.every((item: Row) => item.status === "분석 완료" && String((Array.isArray(item.attachment_texts) ? item.attachment_texts[0] : item.attachment_texts)?.extracted_text ?? "").trim());
  }).map((row: Row) => String(row.id));
  let aiQueued = 0;
  // Keep a small rolling concurrency window for the free Gemini tier. A linear
  // delay per notice made the tail of a recovery run take tens of minutes.
  for (let index = 0; index < noticeIds.length; index += 8) {
    const group = noticeIds.slice(index, index + 8);
    const results = await Promise.all(group.map((noticeId) => enqueueNoticeAiWhenReady(noticeId, 0, options.publish ?? true).catch(() => ({ queued: false }))));
    aiQueued += results.filter((result) => result.queued).length;
  }
  return { aiQueued };
}

export async function processNoticeAiJob(aiJobId: string) {
  const admin = createSupabaseAdminClient();
  const { data: job, error } = await admin.from("notice_ai_jobs").select("*").eq("id", aiJobId).maybeSingle();
  if (error) throw error;
  if (!job || job.status === "완료" || job.status === "처리 중") return { skipped: true };
  const { data: claimed, error: claimError } = await admin.from("notice_ai_jobs").update({ status: "처리 중", attempts: Number(job.attempts) + 1, updated_at: new Date().toISOString() }).eq("id", aiJobId).in("status", ["대기", "실패"]).select("id").maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return { skipped: true };
  console.log(`[Gemini] 시작 job=${aiJobId} notice=${String(job.notice_id)}`);
  try {
    const { data: row, error: noticeError } = await admin.from("notices").select("*, attachments(*, attachment_texts(extracted_text))").eq("id", job.notice_id).single();
    if (noticeError) throw noticeError;
    const notice = noticeOf(row);
    if (notice.attachments.length && !notice.attachments.every((item) => item.status === "분석 완료" && item.extractedText?.trim())) {
      throw new Error("모든 첨부문서 분석 완료 전에는 Gemini 점수를 생성하지 않습니다.");
    }
    const { data: topics, error: topicError } = await admin.from("topics").select("*").limit(10);
    if (topicError) throw topicError;
    for (const topicRow of topics ?? []) {
      const topic = topicOf(topicRow);
      const analysis = { ...await analyzeWithGemini(notice, topic), sourceHash: String(row.source_hash ?? "") };
      const { error: scoreError } = await admin.from("topic_scores").upsert({ topic_id: topic.id, notice_id: notice.id, analysis, score: analysis.score, updated_at: new Date().toISOString() }, { onConflict: "topic_id,notice_id" });
      if (scoreError) throw scoreError;
    }
    await admin.from("attachment_texts").delete().in("attachment_id", notice.attachments.map((item) => item.id));
    await admin.from("notice_ai_jobs").update({ status: "완료", completed_at: new Date().toISOString(), failure_reason: null, updated_at: new Date().toISOString() }).eq("id", aiJobId);
    console.log(`[Gemini] 완료 job=${aiJobId} topics=${(topics ?? []).length}`);
    await finishActiveBatchIfDrained();
    return { skipped: false, analyzed: (topics ?? []).length };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "AI 분석 실패";
    console.error(`[Gemini] 실패 job=${aiJobId}: ${reason}`);
    await admin.from("notice_ai_jobs").update({ status: "실패", failure_reason: reason, updated_at: new Date().toISOString() }).eq("id", aiJobId);
    await finishActiveBatchIfDrained();
    throw cause;
  }
}

/** Safety-net worker for hosts where Vercel Queue delivery is delayed. */
export async function processPendingNoticeAiJobsInline(limit = 32) {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.from("notice_ai_jobs").select("id").eq("status", "대기").order("created_at", { ascending: true }).limit(limit);
  if (error) throw error;
  let processed = 0;
  for (let index = 0; index < (data ?? []).length; index += 4) {
    const group = (data ?? []).slice(index, index + 4);
    const results = await Promise.all(group.map(async (row) => {
      try { await processNoticeAiJob(String(row.id)); return 1; } catch { return 0; }
    }));
    processed += results.reduce<number>((sum, value) => sum + value, 0);
    console.log(`[Gemini] 진행 ${Math.min(index + group.length, data?.length ?? 0)}/${data?.length ?? 0}`);
  }
  return processed;
}
