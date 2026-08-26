import { getBidSource } from "@/lib/sources";
import { createSupabaseAdminClient } from "@/lib/supabase";

const chunk = <T,>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

export async function runCollectionPass() {
  const notices = await getBidSource().listNotices(new Date(Date.now() - 72 * 3_600_000), new Date());
  const validNotices = notices.filter((notice) => Boolean(notice.closesAt));
  const admin = createSupabaseAdminClient();
  const now = new Date().toISOString();
  const rows = validNotices.map((notice) => {
    const sourceHash = JSON.stringify([notice.title, notice.closesAt, notice.status, notice.description]);
    return { bid_number: notice.bidNumber, bid_order: notice.order, title: notice.title, business_type: notice.businessType, status: notice.status, agency: notice.agency, demand_agency: notice.demandAgency, region: notice.region, published_at: notice.publishedAt || null, closes_at: notice.closesAt, budget: notice.budget, budget_label: notice.budgetLabel, contract_method: notice.contractMethod, detail_url: notice.detailUrl, description: notice.description, tasks: notice.tasks, qualifications: notice.qualifications, change_summary: notice.changeSummary ?? null, source_hash: sourceHash, updated_at: now };
  });
  const savedRows: Record<string, any>[] = [];
  for (const part of chunk(rows, 50)) {
    if (!part.length) continue;
    const { data, error } = await admin.from("notices").upsert(part, { onConflict: "bid_number,bid_order" }).select("id,bid_number,bid_order");
    if (error) throw error;
    savedRows.push(...(data ?? []));
  }
  if (savedRows.length !== rows.length) throw new Error("나라장터 공고 일괄 저장 결과가 일부 누락되었습니다.");
  const idByKey = new Map(savedRows.map((row) => [`${row.bid_number}-${row.bid_order}`, String(row.id)]));
  const versions = validNotices.map((notice) => ({ notice_id: idByKey.get(`${notice.bidNumber}-${notice.order}`), source_hash: JSON.stringify([notice.title, notice.closesAt, notice.status, notice.description]), source_payload: notice }));
  for (const part of chunk(versions.filter((row) => row.notice_id), 50)) { const { error } = await admin.from("notice_versions").upsert(part, { onConflict: "notice_id,source_hash" }); if (error) throw error; }
  const attachments = validNotices.flatMap((notice) => notice.attachments.slice(0, 3).map((attachment) => ({ notice_id: idByKey.get(`${notice.bidNumber}-${notice.order}`), source_url: attachment.sourceUrl ?? `unavailable:${attachment.id}`, name: attachment.name, kind: attachment.kind, status: attachment.status }))).filter((row) => row.notice_id);
  const savedAttachments: Record<string, any>[] = [];
  for (const part of chunk(attachments, 50)) { if (!part.length) continue; const { data, error } = await admin.from("attachments").upsert(part, { onConflict: "notice_id,source_url" }).select("id"); if (error) throw error; savedAttachments.push(...(data ?? [])); }
  for (const part of chunk(savedAttachments.map((row) => ({ attachment_id: row.id, status: "대기", failure_reason: null, updated_at: now })), 50)) { if (!part.length) continue; const { error } = await admin.from("processing_jobs").upsert(part, { onConflict: "attachment_id" }); if (error) throw error; }
  return { discovered: validNotices.length, changed: validNotices.filter((notice) => notice.status === "정정" || notice.status === "재공고").length, missingDeadline: notices.length - validNotices.length, noticeIds: savedRows.map((row) => String(row.id)) };
}
