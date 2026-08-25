import type { BidNotice, Notification, NotificationProvider } from "@/lib/types";

/** Keeps the MVP in preview mode while leaving a provider boundary for Resend/SMTP. */
export class PreviewNotificationProvider implements NotificationProvider {
  create(notice: BidNotice): Notification {
    return {
      id: `preview-${notice.id}`,
      bidId: notice.id,
      title: notice.title,
      score: notice.analysis?.score ?? 0,
      message: "이메일 미리보기 대상 공고입니다.",
      createdAt: new Date().toISOString(),
      read: false,
    };
  }
}
