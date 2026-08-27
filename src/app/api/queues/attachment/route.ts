import { handleCallback } from "@vercel/queue";
import { processQueuedAttachmentJob, type AttachmentQueueMessage } from "@/lib/attachment-pass";

export const maxDuration = 300;

// This route has no public URL in Vercel. Only the Queue service can invoke it.
const queueHandler = handleCallback<AttachmentQueueMessage>(async (message) => {
  if (!message?.jobId) throw new Error("첨부문서 작업 식별자가 없습니다.");
  await processQueuedAttachmentJob(message.jobId);
}, { visibilityTimeoutSeconds: 300 });

// Export the callback directly so Vercel Queue can discover and invoke this
// consumer route. A wrapper POST function is not registered as a queue trigger.
export const POST = queueHandler as unknown as (request: Request) => Promise<Response>;
