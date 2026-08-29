import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_OCR_PAGES = 20;

/** Uses the locally installed LibreOffice HWP filter; no network or AI. */
export async function extractHwpTextWithLibreOffice(hwp: Buffer) {
  if (process.env.OCR_ENABLED !== "true" || process.platform !== "linux") return "";
  const directory = await mkdtemp(join(tmpdir(), "bidfit-hwp-"));
  const input = join(directory, "source.hwp");
  try {
    await writeFile(input, hwp);
    await execFileAsync("libreoffice", ["--headless", "--convert-to", "txt:Text", "--outdir", directory, input], { timeout: 120_000, maxBuffer: 1_024 * 1_024 });
    return (await readFile(join(directory, "source.txt"), "utf8")).trim();
  } catch {
    return "";
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Uses pyhwp's deterministic HWP5 converter when available on the worker. */
export async function extractHwpTextWithPyhwp(hwp: Buffer) {
  if (process.env.OCR_ENABLED !== "true" || process.platform !== "linux") return "";
  const directory = await mkdtemp(join(tmpdir(), "bidfit-pyhwp-"));
  const input = join(directory, "source.hwp");
  try {
    await writeFile(input, hwp);
    const result = await execFileAsync("python3", ["-m", "hwp5.hwp5txt", input], { timeout: 120_000, maxBuffer: 4 * 1_024 * 1_024 });
    return result.stdout.trim();
  } catch {
    return "";
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Runs only on the GitHub-hosted Linux worker. Tesseract is a deterministic,
 * local OCR executable; no document content is sent to an AI service here.
 */
export async function extractPdfTextWithTraditionalOcr(pdf: Buffer) {
  if (process.env.OCR_ENABLED !== "true" || process.platform !== "linux") return "";
  const directory = await mkdtemp(join(tmpdir(), "bidfit-ocr-"));
  const input = join(directory, "source.pdf");
  const imagePrefix = join(directory, "page");
  try {
    await writeFile(input, pdf);
    await execFileAsync("pdftoppm", ["-f", "1", "-l", String(MAX_OCR_PAGES), "-r", "200", "-png", input, imagePrefix], { timeout: 90_000, maxBuffer: 1_024 * 1_024 });
    const images = (await readdir(directory)).filter((name) => /^page-\d+\.png$/i.test(name)).sort();
    const parts: string[] = [];
    let lastError: unknown;
    for (const image of images) {
      const output = join(directory, image.replace(/\.png$/i, ""));
      let pageText = "";
      // Korean scans vary considerably in layout. Retry an empty page with a
      // sparse-text segmentation mode before declaring the PDF unextractable.
      for (const psm of [6, 11]) {
        try {
          await execFileAsync("tesseract", [join(directory, image), output, "-l", "kor+eng", "--psm", String(psm)], { timeout: 60_000, maxBuffer: 1_024 * 1_024 });
          pageText = await readFile(`${output}.txt`, "utf8");
          if (pageText.trim()) break;
        } catch (error) {
          lastError = error;
        }
      }
      if (pageText.trim()) parts.push(pageText.trim());
    }
    if (!parts.length && lastError) throw lastError;
    return parts.join("\n\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
