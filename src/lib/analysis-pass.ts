import { RuleAnalysisEngine } from "@/lib/analysis";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { BidNotice, Topic } from "@/lib/types";

type Row = Record<string, any>;
const list = (value: unknown) => Array.isArray(value) ? value.map(String) : [];
const topicOf = (row: Row): Topic => ({ id: String(row.id), name: String(row.name), description: String(row.description ?? ""), capabilities: String(row.capabilities ?? ""), includeKeywords: list(row.include_keywords), excludeKeywords: list(row.exclude_keywords), businessTypes: list(row.business_types) as Topic["businessTypes"], regions: list(row.regions), minBudget: row.min_budget == null ? null : Number(row.min_budget), maxBudget: row.max_budget == null ? null : Number(row.max_budget), minimumDays: Number(row.minimum_days ?? 0), threshold: Number(row.threshold ?? 70) });
const noticeOf = (row: Row): BidNotice => ({ id: String(row.id), bidNumber: String(row.bid_number), order: String(row.bid_order), title: String(row.title), businessType: String(row.business_type) as BidNotice["businessType"], status: String(row.status) as BidNotice["status"], agency: String(row.agency), demandAgency: String(row.demand_agency), region: String(row.region), publishedAt: String(row.published_at), closesAt: String(row.closes_at), budget: row.budget == null ? null : Number(row.budget), budgetLabel: String(row.budget_label), contractMethod: String(row.contract_method), detailUrl: String(row.detail_url), description: String(row.description), tasks: list(row.tasks), qualifications: list(row.qualifications), attachments: [], reviewState: "검토 전" });

export async function runAnalysisPass() {
  const admin = createSupabaseAdminClient();
  const { data: topics, error: topicError } = await admin.from("topics").select("*").limit(10);
  if (topicError) throw topicError;
  if (!topics?.length) return { analyzed: 0, message: "분석 주제가 없습니다." };
  const { data: rows, error: noticeError } = await admin.from("notices").select("*").order("published_at", { ascending: false }).limit(500);
  if (noticeError) throw noticeError;
  const engine = new RuleAnalysisEngine();
  // Re-score the bounded set every day. This makes a topic setting change and
  // a corrected notice version visible immediately, without a stale score.
  const scoreRows = topics.flatMap((topicRow) => (rows ?? []).map((row) => { const result = engine.analyze(noticeOf(row), topicOf(topicRow)); return { topic_id: topicRow.id, notice_id: row.id, analysis: result, score: result.score, updated_at: new Date().toISOString() }; }));
  if (scoreRows.length) { const { error } = await admin.from("topic_scores").upsert(scoreRows, { onConflict: "topic_id,notice_id" }); if (error) throw error; }
  const analyzed = scoreRows.length;
  return { analyzed };
}
