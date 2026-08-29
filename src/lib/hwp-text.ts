import { inflateRawSync, inflateSync } from "node:zlib";
import CFB from "cfb";

type CfbEntry = { name: string; content: Uint8Array };

function textRecords(bytes: Buffer) {
  const chunks: string[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const value = bytes.readUInt32LE(offset); offset += 4;
    const tag = value & 0x3ff;
    let size = value >>> 20;
    if (size === 0xfff && offset + 4 <= bytes.length) { size = bytes.readUInt32LE(offset); offset += 4; }
    if (offset + size > bytes.length) break;
    if (tag === 67 && size >= 2) chunks.push(bytes.subarray(offset, offset + size).toString("utf16le"));
    offset += size;
  }
  return chunks.join("\n").replace(/\u0000/g, "").replace(/\r?\n{3,}/g, "\n\n").trim();
}

// A few HWP producers emit valid BodyText streams with non-standard record
// headers. Recover contiguous Korean/ASCII UTF-16 runs as a deterministic
// fallback when the normal tag-67 parser cannot see those records.
function utf16Runs(bytes: Buffer) {
  const runs: string[] = [];
  let run = "";
  const flush = () => { if (run.replace(/[^\uac00-\ud7a3A-Za-z0-9]/g, "").length >= 4) runs.push(run.trim()); run = ""; };
  for (let offset = 0; offset + 2 <= bytes.length; offset += 2) {
    const code = bytes.readUInt16LE(offset);
    const keep = (code >= 0xac00 && code <= 0xd7a3) || (code >= 0x20 && code <= 0x7e) || "，。·：；？！()[]{}-_/\\,.".includes(String.fromCharCode(code));
    if (keep) run += String.fromCharCode(code);
    else flush();
  }
  flush();
  return runs.join("\n").replace(/\s+/g, " ").trim();
}

function previewText(bytes: Buffer) {
  // HWP5 commonly stores a UTF-16LE preview in PrvText. It is not a full
  // document dump, but remains attachment-derived text and is preferable to
  // silently downgrading an attached notice to title-only analysis.
  return bytes.toString("utf16le")
    .replace(/^\uFEFF/, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extracts text from the binary HWP 5 (OLE Compound File) format. */
export function extractHwpText(input: Buffer): { text: string; pages?: number } {
  const ole = CFB.read(input, { type: "buffer" });
  const entries = ole.FileIndex ?? [];
  const sections = entries.filter((entry) => /(^|\\)BodyText[\\/]Section\\d+$/i.test(entry.name));
  const ordered = sections.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const chunks: string[] = [];
  for (const section of ordered) {
    const original = Buffer.from(section.content);
    const candidates = [original];
    // HWP BodyText streams are raw-deflate compressed when FileHeader flag 0 is set.
    const header = entries.find((entry) => /(^|\\)FileHeader$/i.test(entry.name));
    if (header && header.content.length >= 40 && (header.content[36] & 1) !== 0) {
      for (const inflate of [inflateRawSync, inflateSync]) {
        try { candidates.push(inflate(original)); } catch { /* try the next container format */ }
      }
    }
    const best = candidates.flatMap((candidate) => [textRecords(candidate), utf16Runs(candidate)]).sort((a, b) => b.length - a.length)[0];
    if (best) chunks.push(best);
  }
  let text = chunks.join("\n").replace(/\u0000/g, "").replace(/\r?\n{3,}/g, "\n\n").trim();
  if (!text) {
    const preview = entries.find((entry) => /(^|\\)PrvText$/i.test(entry.name));
    if (preview) text = previewText(Buffer.from(preview.content));
  }
  return { text, pages: ordered.length || undefined };
}
