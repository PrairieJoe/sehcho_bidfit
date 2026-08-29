import { processPendingAttachmentJobsInline, finishActiveBatchIfDrained } from "@/lib/attachment-pass";
import { enqueueReadyNoticeAiJobs, processPendingNoticeAiJobsInline } from "@/lib/notice-ai-pass";
import { requireAdmin } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { currentBatchDiagnostics } from "@/lib/batch-pass";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The admin page uses this continuation when Vercel Queue delivery is slow or
 * unavailable. Each request drains a bounded chunk and can safely be retried.
 */
export async function POST(request: Request) {
  try {
    await requireAdmin();
    const admin = createSupabaseAdminClient();
    const input = await request.json().catch(() => ({})) as { batchId?: string; noticeIds?: string[] };
    const activeQuery = admin.from("batch_runs").select("id,started_at,status").eq("status", "분석 중").order("started_at", { ascending: false }).limit(1);
    const { data: active, error: activeError } = input.batchId ? await admin.from("batch_runs").select("id,started_at,status").eq("id", input.batchId).maybeSingle() : await activeQuery.maybeSingle();
    if (activeError) throw activeError;
    if (!active) return Response.json({ done: true, attachmentProcessed: 0, aiProcessed: 0, pendingAttachments: 0, pendingAi: 0 });
    // Collection upserts touch notice.updated_at. Use that timestamp as the
    // current run's scope so a manual recovery never consumes legacy jobs
    // belonging to another batch (or spends Gemini quota on them).
    let noticeIds = (input.noticeIds ?? []).map(String).filter(Boolean);
    if (!noticeIds.length) {
      const { data: notices, error: noticesError } = await admin.from("notices").select("id").gte("updated_at", String((active as any).started_at ?? ""));
      if (noticesError) throw noticesError;
      noticeIds = (notices ?? []).map((notice: any) => String(notice.id));
    }
    if (!noticeIds.length) return Response.json({ done: true, attachmentProcessed: 0, aiProcessed: 0, pendingAttachments: 0, pendingAi: 0 });
    if (String(active.status) === "완료") {
      const { data: scores, error: scoresError } = await admin.from("topic_scores").select("notice_id,analysis").in("notice_id", noticeIds);
      if (scoresError) throw scoresError;
      const analyzed = new Set((scores ?? []).filter((row: any) => String(row.analysis?.batchId ?? "") === String(active.id) && String(row.analysis?.aiModel ?? "").toLowerCase().startsWith("gemini")).map((row: any) => String(row.notice_id))).size;
      if (analyzed === noticeIds.length) return Response.json({ done: true, complete: true, analyzed, expected: noticeIds.length, attachmentProcessed: 0, aiProcessed: 0, pendingAttachments: 0, pendingAi: 0 });
      await admin.from("batch_runs").update({ status: "분석 중", completed_at: null, error_summary: `Gemini 분석 ${analyzed}/${noticeIds.length}건 재개` }).eq("id", active.id);
    }
    const attachmentProcessed = await processPendingAttachmentJobsInline(40, false, undefined, noticeIds, true);
    // The final attachment in a notice can become text-ready during this
    // request. Re-scan the current collection before draining AI jobs so that
    // those notices cannot finish the continuation with no AI job registered.
    await enqueueReadyNoticeAiJobs({ publish: false, noticeIds });
    const aiProcessed = await processPendingNoticeAiJobsInline(8, undefined, noticeIds, true, String(active.id));
    const [{ count: pendingAttachments, error: attachmentError }, { count: pendingAi, error: aiError }] = await Promise.all([
      admin.from("processing_jobs").select("id,attachments!inner(notice_id)", { count: "exact", head: true }).in("status", ["대기", "처리 중"]).in("attachments.notice_id", noticeIds),
      admin.from("notice_ai_jobs").select("id", { count: "exact", head: true }).in("status", ["대기", "처리 중"]).in("notice_id", noticeIds),
    ]);
    if (attachmentError || aiError) throw attachmentError ?? aiError;
    const pending = (pendingAttachments ?? 0) + (pendingAi ?? 0);
    let analyzed = 0;
    if (pending === 0) {
      const { data: scores, error: scoresError } = await admin.from("topic_scores").select("notice_id,analysis").in("notice_id", noticeIds);
      if (scoresError) throw scoresError;
      analyzed = new Set((scores ?? []).filter((row: any) => String(row.analysis?.batchId ?? "") === String(active.id) && String(row.analysis?.aiModel ?? "").toLowerCase().startsWith("gemini")).map((row: any) => String(row.notice_id))).size;
      const complete = analyzed === noticeIds.length;
      const diagnostics = complete ? null : await currentBatchDiagnostics(admin, noticeIds, String(active.id), String(active.started_at));
      const top = (values: Record<string, number> | undefined) => Object.entries(values ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => `${reason}(${count})`).join("·") || "없음";
      const errorSummary = complete ? null : `Gemini 분석 ${analyzed}/${noticeIds.length}건; 미완료 첨부 공고 ${diagnostics?.attachmentNotReady ?? 0}건·첨부 준비 후 Gemini 미실행 ${diagnostics?.attachmentReadyWithoutGemini ?? 0}건·첨부 없음 Gemini 미실행 ${diagnostics?.noAttachmentWithoutGemini ?? 0}건·quota 실패 ${diagnostics?.quotaFailures ?? 0}건; 첨부 상태 ${top(diagnostics?.attachmentStatusSets)}; 첨부 사유 ${top(diagnostics?.attachmentFailureReasons)}; AI 실패 사유 ${top(diagnostics?.aiFailureReasons)}`;
      const { error: finishError } = await admin.from("batch_runs").update({ status: complete ? "완료" : "부분 완료", completed_at: new Date().toISOString(), analyzed, error_summary: errorSummary }).eq("id", active.id);
      if (finishError) throw finishError;
      return Response.json({ done: true, complete, analyzed, expected: noticeIds.length, attachmentProcessed, aiProcessed, pendingAttachments: 0, pendingAi: 0, diagnostics });
    }
    return Response.json({ done: false, attachmentProcessed, aiProcessed, pendingAttachments: pendingAttachments ?? 0, pendingAi: pendingAi ?? 0 });
  } catch (error) {
    return Response.json({ message: error instanceof Error ? error.message : "분석 작업 이어받기에 실패했습니다." }, { status: 500 });
  }
}
