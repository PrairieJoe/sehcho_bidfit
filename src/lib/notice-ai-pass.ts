import { createHash } from "node:crypto";
import { send } from "@vercel/queue";
import { finishActiveBatchIfDrained } from "@/lib/attachment-pass";
import { analyzeWithGemini, GeminiQuotaError } from "@/lib/gemini";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { BidNotice, Topic } from "@/lib/types";

type Row = Record<string, any>;
const list = (value: unknown) => Array.isArray(value) ? value.map(String) : [];
export const NOTICE_AI_QUEUE_TOPIC = "bidfit-notice-ai";
export type NoticeAiQueueMessage = { aiJobId: string };
const topicOf = (row: Row): Topic => ({ id: String(row.id), name: String(row.name), description: String(row.description ?? ""), capabilities: String(row.capabilities ?? ""), includeKeywords: list(row.include_keywords), excludeKeywords: list(row.exclude_keywords), businessTypes: list(row.business_types) as Topic["businessTypes"], regions: list(row.regions), minBudget: row.min_budget == null ? null : Number(row.min_budget), maxBudget: row.max_budget == null ? null : Number(row.max_budget), minimumDays: Number(row.minimum_days ?? 0), threshold: Number(row.threshold ?? 70) });
const noticeOf = (row: Row): BidNotice => ({ id: String(row.id), bidNumber: String(row.bid_number), order: String(row.bid_order), title: String(row.title), businessType: String(row.business_type) as BidNotice["businessType"], status: String(row.status) as BidNotice["status"], agency: String(row.agency), demandAgency: String(row.demand_agency), region: String(row.region), publishedAt: String(row.published_at ?? ""), closesAt: String(row.closes_at ?? ""), budget: row.budget == null ? null : Number(row.budget), budgetLabel: String(row.budget_label), contractMethod: String(row.contract_method), detailUrl: String(row.detail_url), description: String(row.description), tasks: list(row.tasks), qualifications: list(row.qualifications), attachments: (row.attachments ?? []).map((item: Row) => ({ id: String(item.id), name: String(item.name), kind: String(item.kind), status: String(item.status) as BidNotice["attachments"][number]["status"], extractedText: String((Array.isArray(item.attachment_texts) ? item.attachment_texts[0] : item.attachment_texts)?.extracted_text ?? "") || undefined })), reviewState: "검토 전" });

function inputHashOf(analyzerVersion: string, notice: Row, attachments: Row[]) {
  // Include the collection fingerprint so a completed job from an older
  // overlapping window cannot suppress analysis for a changed/reposted
  // notice in the current batch.
  return createHash("sha256").update(`${analyzerVersion}|${String(notice.source_hash ?? "")}|${String(notice.title ?? "")}|${String(notice.description ?? "")}|${attachments.map((item) => `${item.id}:${item.sha256 ?? ""}:${String((Array.isArray(item.attachment_texts) ? item.attachment_texts[0] : item.attachment_texts)?.extracted_text ?? "").length}`).sort().join("|")}`, "utf8").digest("hex");
}

export async function enqueueNoticeAiWhenReady(noticeId: string, delaySeconds = 0, publish = true) {
  // A missing key must never silently produce a keyword-based score.
  if (!process.env.GEMINI_API_KEY) return { queued: false, reason: "Gemini API 키가 설정되지 않았습니다." };
  const admin = createSupabaseAdminClient();
  const { data: attachments, error } = await admin.from("attachments").select("id,status,sha256,attachment_texts(extracted_text)").eq("notice_id", noticeId);
  if (error) throw error;
  const rows = attachments ?? [];
  const { data: noticeMeta, error: noticeMetaError } = await admin.from("notices").select("title,description,source_hash").eq("id", noticeId).maybeSingle();
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
  const inputHash = inputHashOf(analyzerVersion, noticeMeta ?? {}, rows);
  const { data: inserted, error: jobError } = await admin.from("notice_ai_jobs").upsert({ notice_id: noticeId, input_hash: inputHash, status: "대기" }, { onConflict: "notice_id,input_hash", ignoreDuplicates: true }).select("id,status").maybeSingle();
  if (jobError) throw jobError;
  const job = inserted ?? (await admin.from("notice_ai_jobs").select("id,status").eq("notice_id", noticeId).eq("input_hash", inputHash).maybeSingle()).data;
  if (!job || job.status === "완료") return { queued: false };
  if (publish) await send<NoticeAiQueueMessage>(NOTICE_AI_QUEUE_TOPIC, { aiJobId: String(job.id) }, { idempotencyKey: `${noticeId}:${inputHash}`, retentionSeconds: 86_400, delaySeconds });
  return { queued: true };
}

/** Enqueues old, already-extracted notices after an AI key or model is newly configured. */
export async function enqueueReadyNoticeAiJobs(options: { publish?: boolean; noticeIds?: string[] } = {}) {
  if (!process.env.GEMINI_API_KEY) throw new Error("Gemini API 키가 설정되지 않았습니다. 분석을 시작할 수 없습니다.");
  const admin = createSupabaseAdminClient();
  // Analyze every collected notice. Attachment-backed notices wait until all
  // supported files have extracted text; notices without attachments use the
  // explicit title/description fallback in analyzeWithGemini. The previous
  // attachment-only scan silently excluded no-attachment notices and made the
  // dashboard report a misleading zero.
  const data: Row[] = [];
  if (options.noticeIds?.length) {
    // Supabase REST encodes `.in()` values in the request URL. A daily
    // 24-hour window can still contain hundreds of notices, so keep each
    // filtered read below the proxy/header limit.
    for (let index = 0; index < options.noticeIds.length; index += 100) {
      const { data: part, error } = await admin
        .from("notices")
        .select("id,title,description,source_hash,attachments(id,status,sha256,attachment_texts(extracted_text)),topic_scores(analysis)")
        .in("id", options.noticeIds.slice(index, index + 100));
      if (error) throw error;
      data.push(...(part ?? []));
    }
  } else {
    const { data: part, error } = await admin.from("notices").select("id,title,description,source_hash,attachments(id,status,sha256,attachment_texts(extracted_text)),topic_scores(analysis)").order("updated_at", { ascending: false }).limit(5_000);
    if (error) throw error;
    data.push(...(part ?? []));
  }
  const analyzerVersion = `gemini:${process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite"}`;
  const readyRows = (data ?? []).filter((row: Row) => {
    const attachments = Array.isArray(row.attachments) ? row.attachments : [];
    return attachments.length === 0 || attachments.every((item: Row) => item.status === "분석 완료" && String((Array.isArray(item.attachment_texts) ? item.attachment_texts[0] : item.attachment_texts)?.extracted_text ?? "").trim());
  }).map((row: Row) => ({
    noticeId: String(row.id),
    inputHash: inputHashOf(analyzerVersion, row, Array.isArray(row.attachments) ? row.attachments : []),
    needsAnalysis: !(Array.isArray(row.topic_scores) ? row.topic_scores : []).some((score: Row) => {
      const analysis = score.analysis as Row | null;
      return String(analysis?.aiModel ?? "").toLowerCase().startsWith("gemini") && String(analysis?.sourceHash ?? "") === String(row.source_hash ?? "");
    }),
  }));
  if (!readyRows.length) return { aiQueued: 0 };

  // Register the whole ready set in bounded upsert batches. The former
  // implementation performed two reads and one upsert per notice; with a
  // A large daily service window can exhaust Supabase and
  // stopped the batch before Gemini was ever called.
  for (let index = 0; index < readyRows.length; index += 50) {
    const part = readyRows.slice(index, index + 50).map((row) => ({ notice_id: row.noticeId, input_hash: row.inputHash, status: "대기" }));
    const { error: upsertError } = await admin.from("notice_ai_jobs").upsert(part, { onConflict: "notice_id,input_hash", ignoreDuplicates: true });
    if (upsertError) throw upsertError;
  }
  let aiQueued = 0;
  // Read back only the matching jobs, then publish in a small queue window.
  // The worker path uses publish=false and therefore avoids thousands of queue
  // network calls while still leaving every job durable in Supabase.
  for (let index = 0; index < readyRows.length; index += 100) {
    const part = readyRows.slice(index, index + 100);
    const { data: jobs, error: jobsError } = await admin.from("notice_ai_jobs").select("id,notice_id,input_hash,status,failure_reason").in("notice_id", part.map((row) => row.noticeId));
    if (jobsError) throw jobsError;
    const matching = (jobs ?? []).filter((job: Row) => part.some((row) => row.noticeId === String(job.notice_id) && row.inputHash === String(job.input_hash) && (job.status !== "완료" || row.needsAnalysis)));
    // A quota failure is a durable daily-limit signal, not a transient job
    // failure. Never turn it back into a pending job during the same daily
    // run; doing so repeatedly burns the remaining free-tier allowance and
    // obscures the original cause. Other provider failures may be retried.
    const retryIds = matching
      .filter((job: Row) => job.status === "실패" && !/quota|429|RESOURCE_EXHAUSTED|rate limit/i.test(String(job.failure_reason ?? "")))
      .map((job: Row) => String(job.id));
    const forceIds = matching
      .filter((job: Row) => job.status === "완료" && part.some((row) => row.noticeId === String(job.notice_id) && row.needsAnalysis))
      .map((job: Row) => String(job.id));
    if (retryIds.length) {
      const { error: retryError } = await admin.from("notice_ai_jobs").update({ status: "대기", failure_reason: null, updated_at: new Date().toISOString() }).in("id", retryIds);
      if (retryError) throw retryError;
    }
    if (forceIds.length) {
      const { error: forceError } = await admin.from("notice_ai_jobs").update({ status: "대기", failure_reason: null, updated_at: new Date().toISOString() }).in("id", forceIds);
      if (forceError) throw forceError;
    }
    const retrySet = new Set([...retryIds, ...forceIds]);
    const publishable = matching.filter((job: Row) => job.status === "대기" || retrySet.has(String(job.id)));
    if (options.publish ?? true) {
      for (let offset = 0; offset < publishable.length; offset += 8) {
        await Promise.all(publishable.slice(offset, offset + 8).map((job: Row) => send<NoticeAiQueueMessage>(NOTICE_AI_QUEUE_TOPIC, { aiJobId: String(job.id) }, { idempotencyKey: `${String(job.notice_id)}:${String(job.input_hash)}`, retentionSeconds: 86_400 })));
      }
    }
    aiQueued += publishable.length;
  }
  return { aiQueued };
}

export async function processNoticeAiJob(aiJobId: string, batchId?: string) {
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
    const activeBatch = batchId ? (await admin.from("batch_runs").select("id,started_at").eq("id", batchId).maybeSingle()).data : (await admin.from("batch_runs").select("id,started_at").in("status", ["실행 중", "분석 중"]).order("started_at", { ascending: false }).limit(1).maybeSingle()).data;
    // Once Gemini has rejected one job for the current batch's daily quota,
    // fail subsequent jobs locally instead of issuing hundreds of identical
    // HTTP 429 requests from queue consumers and browser continuations.
    if (activeBatch?.id) {
      const { data: quotaSignal, error: quotaSignalError } = await admin
        .from("notice_ai_jobs")
        .select("id")
        .eq("status", "실패")
        .ilike("failure_reason", "%quota%")
        .gte("updated_at", String(activeBatch.started_at ?? new Date().toISOString()))
        .limit(1)
        .maybeSingle();
      if (quotaSignalError) throw quotaSignalError;
      if (quotaSignal) throw new GeminiQuotaError(429, "현재 배치에서 무료 플랜 quota 초과가 이미 확인되어 추가 API 호출을 차단했습니다.");
    }
    for (const topicRow of topics ?? []) {
      const topic = topicOf(topicRow);
      const analysis = { ...await analyzeWithGemini(notice, topic), sourceHash: String(row.source_hash ?? ""), batchId: activeBatch?.id ? String(activeBatch.id) : undefined };
      const { error: scoreError } = await admin.from("topic_scores").upsert({ topic_id: topic.id, notice_id: notice.id, analysis, score: analysis.score, updated_at: new Date().toISOString() }, { onConflict: "topic_id,notice_id" });
      if (scoreError) throw scoreError;
    }
    await admin.from("attachment_texts").delete().in("attachment_id", notice.attachments.map((item) => item.id));
    await admin.from("notice_ai_jobs").update({ status: "완료", completed_at: new Date().toISOString(), failure_reason: null, updated_at: new Date().toISOString() }).eq("id", aiJobId);
    console.log(`[Gemini] 완료 job=${aiJobId} topics=${(topics ?? []).length}`);
    await finishActiveBatchIfDrained();
    return { skipped: false, analyzed: (topics ?? []).length };
  } catch (cause) {
    const reason = cause instanceof GeminiQuotaError
      ? `Gemini quota 초과로 분석을 보류했습니다. ${cause.message}`
      : cause instanceof Error ? cause.message : "AI 분석 실패";
    console.error(`[Gemini] 실패 job=${aiJobId}: ${reason}`);
    await admin.from("notice_ai_jobs").update({ status: "실패", failure_reason: reason, updated_at: new Date().toISOString() }).eq("id", aiJobId);
    await finishActiveBatchIfDrained();
    throw cause;
  }
}

/** Safety-net worker for hosts where Vercel Queue delivery is delayed. */
export async function processPendingNoticeAiJobsInline(limit = 32, createdSince?: string, noticeIds?: string[], resetCurrentInFlight = false, batchId?: string) {
  const admin = createSupabaseAdminClient();
  if (noticeIds?.length) {
    const staleBefore = new Date(Date.now() - 60_000).toISOString();
    for (let index = 0; index < noticeIds.length; index += 100) {
      let staleQuery = admin.from("notice_ai_jobs").select("id").eq("status", "처리 중").in("notice_id", noticeIds.slice(index, index + 100));
      if (!resetCurrentInFlight) staleQuery = staleQuery.lt("updated_at", staleBefore);
      const { data: stale, error } = await staleQuery;
      if (error) throw error;
      const ids = (stale ?? []).map((row: Row) => String(row.id));
      if (ids.length) {
        const { error: updateError } = await admin.from("notice_ai_jobs").update({ status: "대기", updated_at: new Date().toISOString() }).in("id", ids);
        if (updateError) throw updateError;
      }
    }
    // Retry transient provider failures (for example Gemini HTTP 503 high
    // demand) on the next continuation. Quota failures are deliberately left
    // terminal so a free-tier limit cannot turn into an unbounded retry loop.
    for (let index = 0; index < noticeIds.length; index += 100) {
      const { data: failed, error: failedError } = await admin
        .from("notice_ai_jobs")
        .select("id,failure_reason")
        .eq("status", "실패")
        .in("notice_id", noticeIds.slice(index, index + 100));
      if (failedError) throw failedError;
      const retryIds = (failed ?? [])
        .filter((row: Row) => !String(row.failure_reason ?? "").toLowerCase().includes("quota"))
        .map((row: Row) => String(row.id));
      if (retryIds.length) {
        const { error: retryError } = await admin
          .from("notice_ai_jobs")
          .update({ status: "대기", failure_reason: null, updated_at: new Date().toISOString() })
          .in("id", retryIds);
        if (retryError) throw retryError;
      }
    }
  }
  let data: Row[] = [];
  if (noticeIds?.length) {
    for (let index = 0; index < noticeIds.length && data.length < limit; index += 100) {
      const { data: part, error } = await admin.from("notice_ai_jobs").select("id").eq("status", "대기").in("notice_id", noticeIds.slice(index, index + 100)).order("created_at", { ascending: true }).limit(limit - data.length);
      if (error) throw error;
      data.push(...(part ?? []));
    }
  } else {
    let query = admin.from("notice_ai_jobs").select("id").eq("status", "대기").order("created_at", { ascending: true }).limit(limit);
    if (createdSince) query = query.gte("created_at", createdSince);
    const result = await query;
    data = result.data ?? [];
    if (result.error) throw result.error;
  }
  const { data: activeBatch } = await admin.from("batch_runs").select("id").in("status", ["실행 중", "분석 중"]).order("started_at", { ascending: false }).limit(1).maybeSingle();
  let processed = 0;
  for (let index = 0; index < (data ?? []).length; index += 1) {
    const row = (data ?? [])[index];
    try { await processNoticeAiJob(String(row.id), batchId ?? (activeBatch?.id ? String(activeBatch.id) : undefined)); processed += 1; } catch { /* the job records its durable failure reason */ }
    console.log(`[Gemini] 진행 ${index + 1}/${data?.length ?? 0}`);
  }
  return processed;
}
