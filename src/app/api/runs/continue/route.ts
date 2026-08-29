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
export async function POST() {
  try {
    await requireAdmin();
    const admin = createSupabaseAdminClient();
    const { data: active, error: activeError } = await admin.from("batch_runs").select("id,started_at").eq("status", "분석 중").order("started_at", { ascending: false }).limit(1).maybeSingle();
    if (activeError) throw activeError;
    if (!active) return Response.json({ done: true, attachmentProcessed: 0, aiProcessed: 0, pendingAttachments: 0, pendingAi: 0 });
    // Collection upserts touch notice.updated_at. Use that timestamp as the
    // current run's scope so a manual recovery never consumes legacy jobs
    // belonging to another batch (or spends Gemini quota on them).
    const { data: notices, error: noticesError } = await admin.from("notices").select("id").gte("updated_at", String((active as any).started_at ?? ""));
    if (noticesError) throw noticesError;
    const noticeIds = (notices ?? []).map((notice: any) => String(notice.id));
    if (!noticeIds.length) return Response.json({ done: true, attachmentProcessed: 0, aiProcessed: 0, pendingAttachments: 0, pendingAi: 0 });
    const attachmentProcessed = await processPendingAttachmentJobsInline(40, false, undefined, noticeIds, true);
    const aiProcessed = await processPendingNoticeAiJobsInline(4, undefined, noticeIds, true, String(active.id));
    await finishActiveBatchIfDrained();
    const [{ count: pendingAttachments, error: attachmentError }, { count: pendingAi, error: aiError }] = await Promise.all([
      admin.from("processing_jobs").select("id,attachments!inner(notice_id)", { count: "exact", head: true }).in("status", ["대기", "처리 중"]).in("attachments.notice_id", noticeIds),
      admin.from("notice_ai_jobs").select("id", { count: "exact", head: true }).in("status", ["대기", "처리 중"]).in("notice_id", noticeIds),
    ]);
    if (attachmentError || aiError) throw attachmentError ?? aiError;
    return Response.json({ done: (pendingAttachments ?? 0) === 0 && (pendingAi ?? 0) === 0, attachmentProcessed, aiProcessed, pendingAttachments: pendingAttachments ?? 0, pendingAi: pendingAi ?? 0 });
  } catch (error) {
    return Response.json({ message: error instanceof Error ? error.message : "분석 작업 이어받기에 실패했습니다." }, { status: 500 });
  }
}
