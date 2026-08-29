import { processPendingAttachmentJobsInline, finishActiveBatchIfDrained } from "@/lib/attachment-pass";
import { processPendingNoticeAiJobsInline } from "@/lib/notice-ai-pass";
import { requireAdmin } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase";

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
    const activeQuery = admin.from("batch_runs").select("id,started_at").eq("status", "분석 중").order("started_at", { ascending: false }).limit(1);
    const { data: active, error: activeError } = input.batchId ? await admin.from("batch_runs").select("id,started_at").eq("id", input.batchId).maybeSingle() : await activeQuery.maybeSingle();
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
    const attachmentProcessed = await processPendingAttachmentJobsInline(40, false, undefined, noticeIds, true);
    const aiProcessed = await processPendingNoticeAiJobsInline(4, undefined, noticeIds, true, String(active.id));
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
      await admin.from("batch_runs").update({ status: complete ? "완료" : "부분 완료", completed_at: new Date().toISOString(), analyzed, error_summary: complete ? null : `Gemini 분석 ${analyzed}/${noticeIds.length}건` }).eq("id", active.id);
      return Response.json({ done: true, complete, analyzed, expected: noticeIds.length, attachmentProcessed, aiProcessed, pendingAttachments: 0, pendingAi: 0 });
    }
    return Response.json({ done: false, attachmentProcessed, aiProcessed, pendingAttachments: pendingAttachments ?? 0, pendingAi: pendingAi ?? 0 });
  } catch (error) {
    return Response.json({ message: error instanceof Error ? error.message : "분석 작업 이어받기에 실패했습니다." }, { status: 500 });
  }
}
