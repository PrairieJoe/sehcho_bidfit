import JSZip from "jszip";
import type { Attachment } from "@/lib/types";
import { extractHwpText } from "@/lib/hwp-text";

export const MAX_ATTACHMENTS_PER_NOTICE = 3;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_CHARS = 200_000;

function extensionOf(name: string) { return name.split("?")[0].split(".").pop()?.toLowerCase() ?? ""; }
function cleanXml(value: string) { return value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim(); }

export async function processAttachment(noticeId: string, attachment: Attachment): Promise<Attachment> {
  const extension = extensionOf(attachment.name || attachment.sourceUrl || "");
  if (!attachment.sourceUrl) return { ...attachment, status: "보류", failureReason: "나라장터 API가 첨부파일 다운로드 주소를 제공하지 않았습니다." };
  if (!['pdf', 'hwpx', 'hwp'].includes(extension)) return { ...attachment, status: "보류", failureReason: "PDF·HWP·HWPX만 현재 처리합니다." };
  try {
    const response = await fetch(attachment.sourceUrl, { cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { ...attachment, status: "다운로드 실패", failureReason: `다운로드 HTTP ${response.status}` };
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > MAX_ATTACHMENT_BYTES) return { ...attachment, status: "보류", failureReason: "파일 크기가 10MB 제한을 초과합니다." };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_ATTACHMENT_BYTES) return { ...attachment, status: "보류", failureReason: "파일 크기가 10MB 제한을 초과합니다." };
    let text = "";
    let pages: number | undefined;
    if (extension === "hwp") {
      const parsed = extractHwpText(bytes);
      text = parsed.text;
      pages = parsed.pages;
    } else if (extension === "pdf") {
      const parser = (await import("pdf-parse")).default;
      const parsed = await parser(bytes);
      text = parsed.text;
      pages = parsed.numpages;
    } else {
      const archive = await JSZip.loadAsync(bytes);
      const sections = Object.values(archive.files).filter((file) => /(^|\/)Contents\/section\d+\.xml$/i.test(file.name));
      text = (await Promise.all(sections.map((file) => file.async("string")))).map(cleanXml).join("\n");
      pages = sections.length || undefined;
    }
    if (!text.trim()) return { ...attachment, status: "부분 분석", pages, failureReason: "텍스트를 추출하지 못했습니다. 원문 확인이 필요합니다." };
    return { ...attachment, status: "분석 완료", pages, extractedText: text.slice(0, MAX_EXTRACTED_TEXT_CHARS) };
  } catch (error) {
    return { ...attachment, status: "추출 실패", failureReason: error instanceof Error ? error.message : "첨부파일 처리 중 알 수 없는 오류" };
  }
}
