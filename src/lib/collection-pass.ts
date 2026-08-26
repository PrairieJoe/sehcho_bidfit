import { getBidSource } from "@/lib/sources";
import { createSupabaseAdminClient } from "@/lib/supabase";

export async function runCollectionPass() {
  const notices = await getBidSource().listNotices(new Date(Date.now() - 72 * 3_600_000), new Date());
  const admin = createSupabaseAdminClient();
  for (const notice of notices) {
    const sourceHash = JSON.stringify([notice.title, notice.closesAt, notice.status, notice.description]);
    const { error } = await admin.from("notices").upsert({ bid_number: notice.bidNumber, bid_order: notice.order, title: notice.title, business_type: notice.businessType, status: notice.status, agency: notice.agency, demand_agency: notice.demandAgency, region: notice.region, published_at: notice.publishedAt || new Date().toISOString(), closes_at: notice.closesAt || new Date().toISOString(), budget: notice.budget, budget_label: notice.budgetLabel, contract_method: notice.contractMethod, detail_url: notice.detailUrl, description: notice.description, tasks: notice.tasks, qualifications: notice.qualifications, change_summary: notice.changeSummary ?? null, source_hash: sourceHash, updated_at: new Date().toISOString() }, { onConflict: "bid_number,bid_order" });
    if (error) throw error;
  }
  return { discovered: notices.length, changed: notices.filter((notice) => notice.status === "정정" || notice.status === "재공고").length };
}
