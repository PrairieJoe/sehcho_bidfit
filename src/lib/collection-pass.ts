import { getBidSource } from "@/lib/sources";
import { createSupabaseAdminClient } from "@/lib/supabase";

export async function runCollectionPass() {
  const notices = await getBidSource().listNotices(new Date(Date.now() - 72 * 3_600_000), new Date());
  const admin = createSupabaseAdminClient();
  const validNotices = notices.filter((notice) => Boolean(notice.closesAt));
  const noticeIds: string[] = [];
  for (const notice of validNotices) {
    const sourceHash = JSON.stringify([notice.title, notice.closesAt, notice.status, notice.description]);
    const { data: saved, error } = await admin.from("notices").upsert({ bid_number: notice.bidNumber, bid_order: notice.order, title: notice.title, business_type: notice.businessType, status: notice.status, agency: notice.agency, demand_agency: notice.demandAgency, region: notice.region, published_at: notice.publishedAt || null, closes_at: notice.closesAt, budget: notice.budget, budget_label: notice.budgetLabel, contract_method: notice.contractMethod, detail_url: notice.detailUrl, description: notice.description, tasks: notice.tasks, qualifications: notice.qualifications, change_summary: notice.changeSummary ?? null, source_hash: sourceHash, updated_at: new Date().toISOString() }, { onConflict: "bid_number,bid_order" }).select().single();
    if (error || !saved) throw error ?? new Error("공고 저장 결과가 없습니다.");
    noticeIds.push(String(saved.id));
    await admin.from("notice_versions").upsert({ notice_id: saved.id, source_hash: sourceHash, source_payload: notice }, { onConflict: "notice_id,source_hash" });
    for (const attachment of notice.attachments.slice(0, 3)) {
      const sourceUrl = attachment.sourceUrl ?? `unavailable:${attachment.id}`;
      const { data: savedAttachment, error: attachmentError } = await admin.from("attachments").upsert({ notice_id: saved.id, source_url: sourceUrl, name: attachment.name, kind: attachment.kind, status: attachment.status }, { onConflict: "notice_id,source_url" }).select().single();
      if (attachmentError) throw attachmentError;
      if (savedAttachment) await admin.from("processing_jobs").upsert({ attachment_id: savedAttachment.id, status: "대기", failure_reason: null, updated_at: new Date().toISOString() }, { onConflict: "attachment_id" });
    }
  }
  return { discovered: validNotices.length, changed: validNotices.filter((notice) => notice.status === "정정" || notice.status === "재공고").length, missingDeadline: notices.length - validNotices.length, noticeIds };
}
