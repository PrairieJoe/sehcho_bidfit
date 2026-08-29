import JSZip from "jszip";
import type { Attachment } from "@/lib/types";
import { extractHwpText } from "@/lib/hwp-text";
import { extractHwpTextWithLibreOffice, extractHwpTextWithLibreOfficeOcr, extractHwpTextWithPyhwp, extractPdfTextWithTraditionalOcr } from "@/lib/traditional-ocr";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_CHARS = 200_000;
const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_ARCHIVE_ENTRIES = 30;
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_DOCUMENTS = ['pdf', 'hwpx', 'hwp', 'docx', 'xlsx', 'xlsm', 'pptx'];

function extensionOf(name: string) { return name.split("?")[0].split(".").pop()?.toLowerCase() ?? ""; }
function cleanXml(value: string) { return value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim(); }

async function extractOfficeText(bytes: Buffer, extension: string) {
  const archive = await JSZip.loadAsync(bytes);
  const files = Object.values(archive.files);
  const matching = extension === "docx"
    ? files.filter((file) => /^word\/(document|header\d+|footer\d+)\.xml$/i.test(file.name))
    : extension === "pptx"
      ? files.filter((file) => /^ppt\/slides\/slide\d+\.xml$/i.test(file.name))
      : files.filter((file) => /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/i.test(file.name));
  const text = (await Promise.all(matching.map((file) => file.async("string")))).map(cleanXml).filter(Boolean).join("\n");
  return { text, pages: matching.length || undefined };
}

async function extractBytesText(bytes: Buffer, extension: string): Promise<{ text: string; pages?: number }> {
  let text = "";
  let pages: number | undefined;
  if (extension === "hwp") {
    const parsed = extractHwpText(bytes);
    text = parsed.text;
    pages = parsed.pages;
    if (!text.trim()) text = await extractHwpTextWithPyhwp(bytes);
    if (!text.trim()) text = await extractHwpTextWithLibreOffice(bytes);
    if (!text.trim()) text = await extractHwpTextWithLibreOfficeOcr(bytes);
  } else if (extension === "pdf") {
    const parser = (await import("pdf-parse")).default;
    const parsed = await parser(bytes);
    text = parsed.text;
    pages = parsed.numpages;
    if (!text.trim()) text = await extractPdfTextWithTraditionalOcr(bytes);
  } else if (extension === "hwpx") {
    const archive = await JSZip.loadAsync(bytes);
    const sections = Object.values(archive.files).filter((file) => /(^|\/)Contents\/section\d+\.xml$/i.test(file.name));
    text = (await Promise.all(sections.map((file) => file.async("string")))).map(cleanXml).join("\n");
    pages = sections.length || undefined;
  } else {
    const extracted = await extractOfficeText(bytes, extension);
    text = extracted.text;
    pages = extracted.pages;
  }
  return { text, pages };
}

async function extractZipText(bytes: Buffer): Promise<{ text: string; pages?: number }> {
  const archive = await JSZip.loadAsync(bytes);
  const entries = Object.values(archive.files).filter((file) => !file.dir).slice(0, MAX_ARCHIVE_ENTRIES);
  let totalBytes = 0;
  const parts: string[] = [];
  let pages = 0;
  for (const entry of entries) {
    const extension = extensionOf(entry.name);
    if (!SUPPORTED_DOCUMENTS.includes(extension)) continue;
    const child = Buffer.from(await entry.async("nodebuffer"));
    totalBytes += child.length;
    if (totalBytes > MAX_ARCHIVE_BYTES) break;
    const extracted = await extractBytesText(child, extension).catch(() => ({ text: "", pages: undefined }));
    if (extracted.text.trim()) parts.push(`[${entry.name}]\n${extracted.text}`);
    pages += extracted.pages ?? 0;
  }
  return { text: parts.join("\n\n"), pages: pages || undefined };
}

export async function processAttachment(noticeId: string, attachment: Attachment): Promise<Attachment> {
  const extension = extensionOf(attachment.name || attachment.sourceUrl || "");
  if (!attachment.sourceUrl || attachment.sourceUrl.startsWith("unavailable:")) return { ...attachment, status: "보류", failureReason: "나라장터 API가 첨부파일 다운로드 주소를 제공하지 않았습니다." };
  if (![...SUPPORTED_DOCUMENTS, "zip"].includes(extension)) return { ...attachment, status: "보류", failureReason: "지원하지 않는 파일 형식입니다. ZIP·PDF·HWP·HWPX·DOCX·XLSX·PPTX만 처리합니다." };
  try {
    let response: Response | undefined;
    let lastDownloadError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        response = await fetch(attachment.sourceUrl, { cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(ATTACHMENT_DOWNLOAD_TIMEOUT_MS) });
        if (response.ok || response.status < 500 || attempt === 3) break;
      } catch (error) {
        lastDownloadError = error;
        if (attempt === 3) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
    if (!response) throw lastDownloadError instanceof Error ? lastDownloadError : new Error("첨부파일 다운로드 응답이 없습니다.");
    if (!response.ok) return { ...attachment, status: "다운로드 실패", failureReason: `다운로드 HTTP ${response.status}` };
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > MAX_ATTACHMENT_BYTES) return { ...attachment, status: "보류", failureReason: "파일 크기가 10MB 제한을 초과합니다." };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_ATTACHMENT_BYTES) return { ...attachment, status: "보류", failureReason: "파일 크기가 10MB 제한을 초과합니다." };
    const extracted = extension === "zip" ? await extractZipText(bytes) : await extractBytesText(bytes, extension);
    const text = extracted.text;
    const pages = extracted.pages;
    if (!text.trim()) return { ...attachment, status: "부분 분석", pages, failureReason: extension === "pdf" && process.env.OCR_ENABLED !== "true" ? "텍스트 레이어가 없는 PDF입니다. GitHub Actions OCR 재처리 대기" : `${extension.toUpperCase()} 텍스트를 추출하지 못했습니다. 원문 확인이 필요합니다.` };
    return { ...attachment, status: "분석 완료", pages, extractedText: text.slice(0, MAX_EXTRACTED_TEXT_CHARS) };
  } catch (error) {
    return { ...attachment, status: "추출 실패", failureReason: error instanceof Error ? error.message : "첨부파일 처리 중 알 수 없는 오류" };
  }
}
