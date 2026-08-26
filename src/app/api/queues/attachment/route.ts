import { handleCallback } from "@vercel/queue";
import { processQueuedAttachmentJob, type AttachmentQueueMessage } from "@/lib/attachment-pass";

export const maxDuration = 300;

// This route has no public URL in Vercel. Only the Queue service can invoke it.
const queueHandler = handleCallback<AttachmentQueueMessage>(async (message) => {
  if (!message?.jobId) throw new Error("첨부문서 작업 식별자가 없습니다.");
  await processQueuedAttachmentJob(message.jobId);
}, { visibilityTimeoutSeconds: 300 });

// Keep the App Router's public handler signature while Queue handles the
// callback envelope and acknowledgement protocol internally.
export async function POST(request: Request) {
  return queueHandler(request);
}
