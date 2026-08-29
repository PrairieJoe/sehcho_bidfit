import { inflateRawSync } from "node:zlib";
import CFB from "cfb";

type CfbEntry = { name: string; content: Uint8Array };

/** Extracts text from the binary HWP 5 (OLE Compound File) format. */
export function extractHwpText(input: Buffer): { text: string; pages?: number } {
  const ole = CFB.read(input, { type: "buffer" });
  const entries = ole.FileIndex ?? [];
  const sections = entries.filter((entry) => /(^|\\)BodyText[\\/]Section\\d+$/i.test(entry.name));
  const ordered = sections.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const chunks: string[] = [];
  for (const section of ordered) {
    let bytes = Buffer.from(section.content);
    // HWP BodyText streams are raw-deflate compressed when FileHeader flag 0 is set.
    const header = entries.find((entry) => /(^|\\)FileHeader$/i.test(entry.name));
    if (header && header.content.length >= 40 && (header.content[36] & 1) !== 0) {
      try { bytes = inflateRawSync(bytes); } catch { /* some producers store uncompressed streams */ }
    }
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
  }
  return { text: chunks.join("\n").replace(/\u0000/g, "").replace(/\r?\n{3,}/g, "\n\n").trim(), pages: ordered.length || undefined };
}
