import JSZip from "jszip";
import CFB from "cfb";
import * as XLSX from "xlsx";
import type { Attachment } from "@/lib/types";
import { extractHwpText } from "@/lib/hwp-text";
import { extractHwpTextWithLibreOffice, extractHwpTextWithLibreOfficeOcr, extractHwpTextWithPyhwp, extractPdfTextWithTraditionalOcr } from "@/lib/traditional-ocr";

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_CHARS = 200_000;
const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_ARCHIVE_ENTRIES = 30;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const SUPPORTED_DOCUMENTS = ['pdf', 'hwpx', 'hwp', 'docx', 'xlsx', 'xls', 'xlsb', 'xlsm', 'pptx'];

function extensionOf(name: string) { return name.split("?")[0].split(".").pop()?.toLowerCase() ?? ""; }
function cleanXml(value: string) { return value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim(); }
function looksLikeDocument(bytes: Buffer, extension: string) {
  const head = bytes.subarray(0, 8).toString("hex").toLowerCase();
  if (["hwp", "xls"].includes(extension)) return head.startsWith("d0cf11e0a1b11ae1");
  if (["hwpx", "docx", "xlsx", "xlsb", "xlsm", "pptx", "zip"].includes(extension)) return head.startsWith("504b0304") || head.startsWith("504b0506");
  if (extension === "pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  return true;
}

function sniffExtension(bytes: Buffer, declaredExtension: string) {
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "pdf";
  const head = bytes.subarray(0, 8).toString("hex").toLowerCase();
  if (head.startsWith("504b0304") || head.startsWith("504b0506")) return "zip";
  if (head.startsWith("d0cf11e0a1b11ae1")) return declaredExtension === "xls" ? "xls" : "hwp";
  return declaredExtension;
}

function downloadCandidates(sourceUrl: string) {
  const candidates = [sourceUrl];
  try {
    const url = new URL(sourceUrl);
    // Some G2B deployments use the fileType discriminator for the same
    // public attachment service. Try the documented LSTD/LSTG variants only
    // when the API supplied an empty discriminator; never replace the source
    // URL unless the returned bytes have the expected document signature.
    if (url.hostname.endsWith("g2b.go.kr") && url.pathname.includes("UntyAtchFile/downloadFile.do") && !url.searchParams.get("fileType")) {
      for (const fileType of ["LSTD", "LSTG"]) {
        const variant = new URL(url);
        variant.searchParams.set("fileType", fileType);
        candidates.push(variant.toString());
      }
    }
  } catch {
    // The original URL will produce the normal, recorded failure below.
  }
  return candidates;
}

function refererFor(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl);
    const bidNumber = url.searchParams.get("bidPbancNo");
    const bidOrder = url.searchParams.get("bidPbancOrd") ?? "000";
    return bidNumber ? `https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=${encodeURIComponent(bidNumber)}&bidPbancOrd=${encodeURIComponent(bidOrder)}` : "https://www.g2b.go.kr/";
  } catch {
    return "https://www.g2b.go.kr/";
  }
}

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

function extractLegacyXlsText(bytes: Buffer) {
  const workbook = CFB.read(bytes, { type: "buffer" });
  const streams = (workbook.FileIndex ?? []).filter((entry: any) => entry.type === 2 && /^(Workbook|Book)$/i.test(String(entry.name)));
  const chunks: string[] = [];
  for (const stream of streams) {
    const content = Buffer.from(stream.content ?? []);
    let current = "";
    for (let offset = 0; offset + 1 < content.length; offset += 2) {
      const code = content.readUInt16LE(offset);
      const printable = code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127 && (code < 0xd800 || code > 0xdfff));
      if (printable) current += String.fromCharCode(code);
      else {
        if (current.trim().length >= 3) chunks.push(current.trim());
        current = "";
      }
    }
    if (current.trim().length >= 3) chunks.push(current.trim());
  }
  return [...new Set(chunks)].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractXlsbText(bytes: Buffer) {
  const workbook = XLSX.read(bytes, { type: "buffer", cellDates: false });
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    return `[${name}]\n${XLSX.utils.sheet_to_csv(sheet, { blankrows: false })}`;
  }).join("\n\n").trim();
}

async function extractBytesText(bytes: Buffer, extension: string): Promise<{ text: string; pages?: number }> {
  let text = "";
  let pages: number | undefined;
  if (extension === "hwp") {
    try {
      const parsed = extractHwpText(bytes);
      text = parsed.text;
      pages = parsed.pages;
    } catch {
      // A mislabeled or producer-specific HWP must still reach the worker
      // converters below instead of aborting the whole extraction chain.
    }
    if (!text.trim()) text = await extractHwpTextWithPyhwp(bytes);
    if (!text.trim()) text = await extractHwpTextWithLibreOffice(bytes);
    if (!text.trim()) text = await extractHwpTextWithLibreOfficeOcr(bytes);
  } else if (extension === "pdf") {
    const parser = (await import("pdf-parse")).default;
    try {
      const parsed = await parser(bytes);
      text = parsed.text;
      pages = parsed.numpages;
    } catch {
      // A damaged/scanner-produced PDF may still render successfully. Do not
      // stop at pdf-parse's structural error; let the traditional OCR path
      // make the final determination without using another AI model.
    }
    if (!text.trim()) {
      try { text = await extractPdfTextWithTraditionalOcr(bytes); } catch { /* recorded as extraction failure below */ }
    }
  } else if (extension === "xls") {
    text = extractLegacyXlsText(bytes);
  } else if (extension === "xlsb") {
    text = extractXlsbText(bytes);
  } else if (extension === "hwpx") {
    try {
      const archive = await JSZip.loadAsync(bytes);
      const sections = Object.values(archive.files).filter((file) => /(^|\/)Contents\/section\d+\.xml$/i.test(file.name));
      text = (await Promise.all(sections.map((file) => file.async("string")))).map(cleanXml).join("\n");
      pages = sections.length || undefined;
    } catch {
      // Some servers return a mislabeled HWP/XML response. Let the local
      // LibreOffice fallbacks decide whether it is still a readable document.
    }
    if (!text.trim()) text = await extractHwpTextWithLibreOffice(bytes);
    if (!text.trim()) text = await extractHwpTextWithLibreOfficeOcr(bytes);
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
  // A small number of G2B notices expose a document with a backup/binary
  // suffix. Download those candidates and accept them only after a known
  // PDF/ZIP/CFB signature is detected; ordinary unsupported formats remain
  // explicitly deferred.
  const sniffableUnknown = ["bak", "bin", "dat"].includes(extension);
  if (![...SUPPORTED_DOCUMENTS, "zip"].includes(extension) && !sniffableUnknown) return { ...attachment, status: "보류", failureReason: "지원하지 않는 파일 형식입니다. ZIP·PDF·HWP·HWPX·DOCX·XLSX·XLSB·XLSM·PPTX 또는 문서 시그니처가 확인되는 BAK/BIN/DAT만 처리합니다." };
  try {
    let response: Response | undefined;
    let responseUrl = attachment.sourceUrl;
    let bytes: Buffer | undefined;
    let lastDownloadError: unknown;
    for (const candidateUrl of downloadCandidates(attachment.sourceUrl)) {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          response = await fetch(candidateUrl, {
            cache: "no-store",
            redirect: "follow",
            headers: {
              Accept: "application/octet-stream, application/pdf, application/zip, */*",
              "User-Agent": "Mozilla/5.0 (compatible; BidFit/1.0)",
              Referer: refererFor(candidateUrl),
              "Sec-Fetch-Dest": "document",
              "Sec-Fetch-Mode": "navigate",
              "Sec-Fetch-Site": "same-origin",
            },
            signal: AbortSignal.timeout(ATTACHMENT_DOWNLOAD_TIMEOUT_MS),
          });
          if (!response.ok) {
            lastDownloadError = new Error(`다운로드 HTTP ${response.status}`);
            break;
          }
          const declaredSize = Number(response.headers.get("content-length") ?? 0);
          if (declaredSize > MAX_ATTACHMENT_BYTES) return { ...attachment, status: "보류", failureReason: "파일 크기가 50MB 제한을 초과합니다." };
          const candidateBytes = Buffer.from(await response.arrayBuffer());
          if (candidateBytes.length > MAX_ATTACHMENT_BYTES) return { ...attachment, status: "보류", failureReason: "파일 크기가 50MB 제한을 초과합니다." };
          const detectedExtension = sniffExtension(candidateBytes, extension);
          if (!looksLikeDocument(candidateBytes, sniffableUnknown ? detectedExtension : extension) || (sniffableUnknown && detectedExtension === extension)) {
            lastDownloadError = new Error(`${extension.toUpperCase()}이 아닌 응답(${candidateBytes.subarray(0, 8).toString("hex")})`);
            break;
          }
          bytes = candidateBytes;
          responseUrl = candidateUrl;
          break;
        } catch (error) {
          lastDownloadError = error;
          if (attempt === 3) break;
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
      if (bytes) break;
    }
    if (!response || !bytes) throw lastDownloadError instanceof Error ? lastDownloadError : new Error("첨부파일 다운로드 응답이 없습니다.");
    const effectiveExtension = sniffExtension(bytes, extension);
    let extracted = effectiveExtension === "zip" ? await extractZipText(bytes) : await extractBytesText(bytes, effectiveExtension);
    // CFB containers are used by both legacy HWP and XLS. If a sniffed backup
    // is not readable as HWP, make the non-AI XLS parser the second attempt.
    if (!extracted.text.trim() && sniffableUnknown && effectiveExtension === "hwp") extracted = await extractBytesText(bytes, "xls");
    const text = extracted.text;
    const pages = extracted.pages;
    if (!text.trim()) return { ...attachment, status: "부분 분석", pages, failureReason: extension === "pdf" && process.env.OCR_ENABLED !== "true" ? "텍스트 레이어가 없는 PDF입니다. GitHub Actions OCR 재처리 대기" : `${extension.toUpperCase()} 텍스트를 추출하지 못했습니다. 원문 확인이 필요합니다.` };
    return { ...attachment, sourceUrl: responseUrl, status: "분석 완료", pages, extractedText: text.slice(0, MAX_EXTRACTED_TEXT_CHARS) };
  } catch (error) {
    return { ...attachment, status: "추출 실패", failureReason: error instanceof Error ? error.message : "첨부파일 처리 중 알 수 없는 오류" };
  }
}
