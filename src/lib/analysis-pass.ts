import { RuleAnalysisEngine } from "@/lib/analysis";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { BidNotice, Topic } from "@/lib/types";

type Row = Record<string, any>;
const list = (value: unknown) => Array.isArray(value) ? value.map(String) : [];
const topicOf = (row: Row): Topic => ({ id: String(row.id), name: String(row.name), description: String(row.description ?? ""), capabilities: String(row.capabilities ?? ""), includeKeywords: list(row.include_keywords), excludeKeywords: list(row.exclude_keywords), businessTypes: list(row.business_types) as Topic["businessTypes"], regions: list(row.regions), minBudget: row.min_budget == null ? null : Number(row.min_budget), maxBudget: row.max_budget == null ? null : Number(row.max_budget), minimumDays: Number(row.minimum_days ?? 0), threshold: Number(row.threshold ?? 70) });
const attachmentOf = (row: Row) => {
  const textRow = Array.isArray(row.attachment_texts) ? row.attachment_texts[0] : row.attachment_texts;
  return { id: String(row.id), name: String(row.name), kind: String(row.kind), status: String(row.status) as BidNotice["attachments"][number]["status"], pages: row.pages == null ? undefined : Number(row.pages), sourceUrl: String(row.source_url ?? "") || undefined, extractedText: String(textRow?.extracted_text ?? "") || undefined, failureReason: String(row.failure_reason ?? "") || undefined };
};
const noticeOf = (row: Row): BidNotice => ({ id: String(row.id), bidNumber: String(row.bid_number), order: String(row.bid_order), title: String(row.title), businessType: String(row.business_type) as BidNotice["businessType"], status: String(row.status) as BidNotice["status"], agency: String(row.agency), demandAgency: String(row.demand_agency), region: String(row.region), publishedAt: String(row.published_at ?? ""), closesAt: String(row.closes_at ?? ""), budget: row.budget == null ? null : Number(row.budget), budgetLabel: String(row.budget_label), contractMethod: String(row.contract_method), detailUrl: String(row.detail_url), description: String(row.description), tasks: list(row.tasks), qualifications: list(row.qualifications), attachments: Array.isArray(row.attachments) ? row.attachments.map(attachmentOf) : [], reviewState: "검토 전" });

export async function runAnalysisPass(noticeIds?: string[]) {
  const admin = createSupabaseAdminClient();
  const { data: topics, error: topicError } = await admin.from("topics").select("*").limit(10);
  if (topicError) throw topicError;
  if (!topics?.length) return { analyzed: 0, message: "분석 주제가 없습니다." };
  let noticeQuery = admin.from("notices").select("*, attachments(*, attachment_texts(*))").order("published_at", { ascending: false }).limit(500);
  if (noticeIds) noticeQuery = noticeQuery.in("id", noticeIds);
  const { data: rows, error: noticeError } = await noticeQuery;
  if (noticeError) throw noticeError;
  const engine = new RuleAnalysisEngine();
  const notices = (rows ?? []).map(noticeOf);
  // 공개 점수는 적어도 하나의 첨부문서가 텍스트 추출까지 완료되고, 처리 가능한
  // 첨부문서가 더 이상 대기 중이 아닐 때만 생성한다.
  const ready = notices.filter((notice) => {
    const hasCompleted = notice.attachments.some((attachment) => attachment.status === "분석 완료");
    const pending = notice.attachments.some((attachment) => attachment.status === "대기" || attachment.status === "처리 중");
    return hasCompleted && !pending && Boolean(notice.closesAt);
  });
  const notReadyIds = notices.filter((notice) => !ready.some((candidate) => candidate.id === notice.id)).map((notice) => notice.id);
  if (notReadyIds.length) {
    const { error: deleteError } = await admin.from("topic_scores").delete().in("notice_id", notReadyIds).in("topic_id", topics.map((topic) => topic.id));
    if (deleteError) throw deleteError;
  }
  const scoreRows = topics.flatMap((topicRow) => ready.map((notice) => { const result = engine.analyze(notice, topicOf(topicRow)); return { topic_id: topicRow.id, notice_id: notice.id, analysis: result, score: result.score, updated_at: new Date().toISOString() }; }));
  if (scoreRows.length) { const { error } = await admin.from("topic_scores").upsert(scoreRows, { onConflict: "topic_id,notice_id" }); if (error) throw error; }
  const analyzed = scoreRows.length;
  return { analyzed };
}
