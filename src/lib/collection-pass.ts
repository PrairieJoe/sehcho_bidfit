import { getBidSource } from "@/lib/sources";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { latestAnalysisWindow } from "@/lib/collection-window";

const chunk = <T,>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
async function retryQuery<T>(operation: () => Promise<{ data: T | null; error: { message?: string } | null }>, attempts = 3) {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await operation();
      if (!result.error) return result;
      last = result.error;
    } catch (error) { last = error; }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 1_500));
  }
  throw last instanceof Error ? last : new Error("Supabase 저장 재시도 실패");
}

export async function runCollectionPass(runStartedAt = new Date()) {
  const windowEnd = runStartedAt;
  const source = getBidSource();
  const selectedWindow = latestAnalysisWindow(windowEnd);
  const { windowStart, windowHours } = selectedWindow;
  const notices = await source.listNotices(windowStart, windowEnd);
  // A missing/invalid deadline is a data-quality issue, not a reason to drop
  // the notice. Keep the notice in the daily snapshot so the user can see it
  // and the detail page can show “확인 필요” instead of silently losing it.
  const validNotices = notices;
  const admin = createSupabaseAdminClient();
  const now = new Date().toISOString();
  const rows = validNotices.map((notice) => {
    const sourceHash = JSON.stringify([notice.title, notice.closesAt, notice.status, notice.description]);
    return { bid_number: notice.bidNumber, bid_order: notice.order, title: notice.title, business_type: notice.businessType, status: notice.status, agency: notice.agency, demand_agency: notice.demandAgency, region: notice.region, published_at: notice.publishedAt || null, closes_at: notice.closesAt || null, budget: notice.budget, budget_label: notice.budgetLabel, contract_method: notice.contractMethod, detail_url: notice.detailUrl, description: notice.description, tasks: notice.tasks, qualifications: notice.qualifications, change_summary: notice.changeSummary ?? null, source_hash: sourceHash, updated_at: now };
  });
  const savedRows: Record<string, any>[] = [];
  // Keep payloads small so Supabase's edge proxy does not reject a large body.
  for (const part of chunk(rows, 10)) {
    if (!part.length) continue;
    const { data } = await retryQuery(async () => await admin.from("notices").upsert(part, { onConflict: "bid_number,bid_order" }).select("id,bid_number,bid_order"));
    savedRows.push(...(data ?? []));
  }
  if (savedRows.length !== rows.length) throw new Error("나라장터 공고 일괄 저장 결과가 일부 누락되었습니다.");
  const idByKey = new Map(savedRows.map((row) => [`${row.bid_number}-${row.bid_order}`, String(row.id)]));
  const versions = validNotices.map((notice) => ({ notice_id: idByKey.get(`${notice.bidNumber}-${notice.order}`), source_hash: JSON.stringify([notice.title, notice.closesAt, notice.status, notice.description]), source_payload: notice }));
  for (const part of chunk(versions.filter((row) => row.notice_id), 10)) { await retryQuery(async () => await admin.from("notice_versions").upsert(part, { onConflict: "notice_id,source_hash" }).select()); }
  // Do not overwrite an already processed attachment with the source's initial
  // `대기` status on every overlapping daily collection run.
  const attachments = validNotices.flatMap((notice) => notice.attachments.map((attachment) => ({ notice_id: idByKey.get(`${notice.bidNumber}-${notice.order}`), source_url: attachment.sourceUrl ?? `unavailable:${attachment.id}`, name: attachment.name, kind: attachment.kind }))).filter((row) => row.notice_id);
  const savedAttachments: Record<string, any>[] = [];
  for (const part of chunk(attachments, 25)) { if (!part.length) continue; const { data } = await retryQuery(async () => await admin.from("attachments").upsert(part, { onConflict: "notice_id,source_url" }).select("id")); savedAttachments.push(...(data ?? [])); }
  // Existing completed jobs must not be reset to "대기" every day. New and stale
  // jobs are published to Vercel Queue by the batch coordinator instead.
  for (const part of chunk(savedAttachments.map((row) => ({ attachment_id: row.id, status: "대기", failure_reason: null, updated_at: now })), 25)) { if (!part.length) continue; await retryQuery(async () => await admin.from("processing_jobs").upsert(part, { onConflict: "attachment_id", ignoreDuplicates: true }).select()); }
  return { discovered: validNotices.length, changed: validNotices.filter((notice) => notice.status === "정정" || notice.status === "재공고").length, missingDeadline: notices.length - validNotices.length, noticeIds: savedRows.map((row) => String(row.id)), windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(), windowHours, queryCount: selectedWindow.queryCount };
}
