import { runAnalysisPass } from "@/lib/analysis-pass";
import { runAttachmentPass } from "@/lib/attachment-pass";
import { runCollectionPass } from "@/lib/collection-pass";
import { ensureDefaultTopic } from "@/lib/repository";
import { createSupabaseAdminClient } from "@/lib/supabase";

/** Runs the daily unit of work and records the outcome shown on the dashboard. */
export async function runDailyBatch() {
  const admin = createSupabaseAdminClient();
  const { data: started, error: startError } = await admin.from("batch_runs").insert({}).select().single();
  if (startError || !started) throw startError ?? new Error("실행 이력을 만들 수 없습니다.");
  try {
    await ensureDefaultTopic();
    const collection = await runCollectionPass();
    const attachment = await runAttachmentPass();
    const analysis = await runAnalysisPass();
    const result = { ...collection, ...attachment, analyzed: analysis.analyzed };
    const { error: finishError } = await admin.from("batch_runs").update({
      completed_at: new Date().toISOString(), status: "완료", discovered: result.discovered,
      changed: result.changed, analyzed: result.analyzed, api_calls: 4,
    }).eq("id", started.id);
    if (finishError) throw finishError;
    return result;
  } catch (error) {
    await admin.from("batch_runs").update({ completed_at: new Date().toISOString(), status: "부분 완료", error_summary: error instanceof Error ? error.message : "알 수 없는 오류" }).eq("id", started.id);
    throw error;
  }
}
