import { runGithubActionsBatch } from "../src/lib/batch-pass";

const result = await runGithubActionsBatch();
console.log(JSON.stringify({
  discovered: result.discovered,
  attachmentProcessed: result.attachmentProcessed,
  aiProcessed: result.aiProcessed,
  analyzed: result.analyzed,
  complete: result.complete,
}, null, 2));
if (!result.complete) process.exitCode = 2;
