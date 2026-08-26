import { handleCallback } from "@vercel/queue";
import { processNoticeAiJob, type NoticeAiQueueMessage } from "@/lib/notice-ai-pass";

export const maxDuration = 120;
const queueHandler = handleCallback<NoticeAiQueueMessage>(async (message) => {
  if (!message?.aiJobId) throw new Error("AI 분석 작업 식별자가 없습니다.");
  await processNoticeAiJob(message.aiJobId);
}, { visibilityTimeoutSeconds: 120, retry: (_error, metadata) => metadata.deliveryCount >= 3 ? { acknowledge: true } : { afterSeconds: 60 } });

export async function POST(request: Request) { return queueHandler(request); }
