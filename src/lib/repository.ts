import { defaultTopic } from "@/lib/topic-default";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { BatchRun, BidNotice, Notification, Topic } from "@/lib/types";

type Row = Record<string, unknown>;
const array = (value: unknown) => Array.isArray(value) ? value.map(String) : [];
const topicOf = (row: Row): Topic => ({ id: String(row.id), name: String(row.name), description: String(row.description), capabilities: String(row.capabilities ?? ""), includeKeywords: array(row.include_keywords), excludeKeywords: array(row.exclude_keywords), businessTypes: array(row.business_types) as Topic["businessTypes"], regions: array(row.regions), minBudget: row.min_budget === null ? null : Number(row.min_budget), maxBudget: row.max_budget === null ? null : Number(row.max_budget), minimumDays: Number(row.minimum_days), threshold: Number(row.threshold) });
const noticeOf = (row: Row, state?: Row): BidNotice => ({ id: String(row.id), bidNumber: String(row.bid_number), order: String(row.bid_order), title: String(row.title), businessType: String(row.business_type) as BidNotice["businessType"], status: String(row.status) as BidNotice["status"], agency: String(row.agency), demandAgency: String(row.demand_agency), region: String(row.region), publishedAt: String(row.published_at), closesAt: String(row.closes_at), budget: row.budget === null ? null : Number(row.budget), budgetLabel: String(row.budget_label), contractMethod: String(row.contract_method), detailUrl: String(row.detail_url), description: String(row.description), tasks: array(row.tasks), qualifications: array(row.qualifications), changeSummary: String(row.change_summary ?? "") || undefined, attachments: Array.isArray(row.attachments) ? row.attachments.map((item) => { const attachment = item as Row; const text = attachment.attachment_texts as Row | undefined; return { id: String(attachment.id), name: String(attachment.name), kind: String(attachment.kind), status: String(attachment.status) as BidNotice["attachments"][number]["status"], pages: attachment.pages ? Number(attachment.pages) : undefined, sourceUrl: String(attachment.source_url ?? "") || undefined, storagePath: String(attachment.storage_path ?? "") || undefined, failureReason: String(attachment.failure_reason ?? "") || undefined, extractedText: String(text?.extracted_text ?? "") || undefined }; }) : [], analysis: (Array.isArray(row.topic_scores) ? (row.topic_scores[0] as Row | undefined) : row.topic_scores as Row | undefined)?.analysis as BidNotice["analysis"], reviewState: state?.review_state as BidNotice["reviewState"] ?? "검토 전", memo: String(state?.memo ?? "") || undefined });
const runOf = (row: Row): BatchRun => ({ id: String(row.id), startedAt: String(row.started_at), completedAt: row.completed_at ? String(row.completed_at) : undefined, status: String(row.status) as BatchRun["status"], discovered: Number(row.discovered), changed: Number(row.changed), analyzed: Number(row.analyzed), notified: Number(row.notified), apiCalls: Number(row.api_calls), errorSummary: String(row.error_summary ?? "") || undefined });
async function latestCompletedRunStart(admin: ReturnType<typeof createSupabaseAdminClient>) {
  const { data } = await admin.from("batch_runs").select("started_at").eq("status", "완료").order("started_at", { ascending: false }).limit(1).maybeSingle();
  return data?.started_at ? String(data.started_at) : undefined;
}

export class PublicRepository {
  private admin = createSupabaseAdminClient();
  async getTopic() { const { data } = await this.admin.from("topics").select("*").order("created_at").limit(1).maybeSingle(); return data ? topicOf(data) : { id: "default", ...defaultTopic }; }
  async listNotices() { const topic = await this.getTopic(); const runStart = await latestCompletedRunStart(this.admin); let query = this.admin.from("notices").select("*, attachments(*), topic_scores!left(analysis, topic_id)").order("closes_at"); if (runStart) query = query.gte("updated_at", runStart); const { data, error } = await query; if (error) throw error; return (data ?? []).map((row: Row) => noticeOf({ ...row, topic_scores: (row.topic_scores as Row[] | undefined)?.filter((score) => score.topic_id === topic.id && typeof (score.analysis as Row | undefined)?.aiModel === "string") })); }
  async getNotice(id: string) { return (await this.listNotices()).find((notice) => notice.id === id); }
  async listNotifications(): Promise<Notification[]> { return []; }
  async listRuns(): Promise<BatchRun[]> { const { data, error } = await this.admin.from("batch_runs").select("*").order("started_at", { ascending: false }).limit(20); if (error) throw error; return (data ?? []).map(runOf); }
  async updateTopic(_patch: Partial<Topic>) { throw new Error("관리자 전용 API를 사용하세요."); }
  async markNotificationRead(_id: string): Promise<Notification | undefined> { throw new Error("일반 사용자는 알림을 수정할 수 없습니다."); }
  async updateNotice(id: string, _patch: Pick<BidNotice, "reviewState" | "memo">): Promise<BidNotice | undefined> { throw new Error(`관리자 전용 API를 사용하세요: ${id}`); }
  async runDailyAnalysis() { throw new Error("관리자 전용 API를 사용하세요."); }
}

export async function ensureDefaultTopic() {
  const admin = createSupabaseAdminClient();
  const { data: topics, error } = await admin.from("topics").select("id").limit(1);
  if (error) throw error;
  if (topics?.length) return;
  const { error: insertError } = await admin.from("topics").insert({ user_id: null, name: defaultTopic.name, description: defaultTopic.description, capabilities: defaultTopic.capabilities, include_keywords: defaultTopic.includeKeywords, exclude_keywords: defaultTopic.excludeKeywords, business_types: defaultTopic.businessTypes, regions: defaultTopic.regions, min_budget: defaultTopic.minBudget, max_budget: defaultTopic.maxBudget, minimum_days: defaultTopic.minimumDays, threshold: defaultTopic.threshold });
  if (insertError) throw insertError;
}
