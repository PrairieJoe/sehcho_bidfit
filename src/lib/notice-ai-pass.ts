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
  if (!rows.some((item: Row) => item.status === "분석 완료") || rows.some((item: Row) => item.status === "대기" || item.status === "처리 중")) return { queued: false };
  const analyzerVersion = `gemini:${process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite"}`;
  const inputHash = createHash("sha256").update(`${analyzerVersion}|${rows.map((item: Row) => `${item.id}:${item.sha256 ?? ""}:${String((Array.isArray(item.attachment_texts) ? item.attachment_texts[0] : item.attachment_texts)?.extracted_text ?? "").length}`).sort().join("|")}`, "utf8").digest("hex");
  const { data: inserted, error: jobError } = await admin.from("notice_ai_jobs").upsert({ notice_id: noticeId, input_hash: inputHash, status: "대기" }, { onConflict: "notice_id,input_hash", ignoreDuplicates: true }).select("id,status").maybeSingle();
  if (jobError) throw jobError;
  const job = inserted ?? (await admin.from("notice_ai_jobs").select("id,status").eq("notice_id", noticeId).eq("input_hash", inputHash).maybeSingle()).data;
  if (!job || job.status === "완료") return { queued: false };
  if (publish) await send<NoticeAiQueueMessage>(NOTICE_AI_QUEUE_TOPIC, { aiJobId: String(job.id) }, { idempotencyKey: `${noticeId}:${inputHash}`, retentionSeconds: 86_400, delaySeconds });
  return { queued: true };
}

/** Enqueues old, already-extracted notices after an AI key or model is newly configured. */
export async function enqueueReadyNoticeAiJobs(options: { publish?: boolean } = {}) {
  const admin = createSupabaseAdminClient();
  // Publish a bounded slice per daily run. Queue retention keeps the rest for
  // the next run; scanning and sending hundreds of messages serially can make
  // the Vercel coordinator hit its execution limit.
  const { data, error } = await admin.from("attachments").select("notice_id").eq("status", "분석 완료").limit(32);
  if (error) throw error;
  const noticeIds = [...new Set((data ?? []).map((row: Row) => String(row.notice_id)))];
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
  try {
    const { data: row, error: noticeError } = await admin.from("notices").select("*, attachments(*, attachment_texts(extracted_text))").eq("id", job.notice_id).single();
    if (noticeError) throw noticeError;
    const notice = noticeOf(row);
    const { data: topics, error: topicError } = await admin.from("topics").select("*").limit(10);
    if (topicError) throw topicError;
    for (const topicRow of topics ?? []) {
      const topic = topicOf(topicRow);
      const analysis = await analyzeWithGemini(notice, topic);
      const { error: scoreError } = await admin.from("topic_scores").upsert({ topic_id: topic.id, notice_id: notice.id, analysis, score: analysis.score, updated_at: new Date().toISOString() }, { onConflict: "topic_id,notice_id" });
      if (scoreError) throw scoreError;
    }
    await admin.from("attachment_texts").delete().in("attachment_id", notice.attachments.map((item) => item.id));
    await admin.from("notice_ai_jobs").update({ status: "완료", completed_at: new Date().toISOString(), failure_reason: null, updated_at: new Date().toISOString() }).eq("id", aiJobId);
    await finishActiveBatchIfDrained();
    return { skipped: false, analyzed: (topics ?? []).length };
  } catch (cause) {
    await admin.from("notice_ai_jobs").update({ status: "실패", failure_reason: cause instanceof Error ? cause.message : "AI 분석 실패", updated_at: new Date().toISOString() }).eq("id", aiJobId);
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
  }
  return processed;
}
