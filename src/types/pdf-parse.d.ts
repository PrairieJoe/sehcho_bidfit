declare module "pdf-parse" {
  interface PdfResult { text: string; numpages: number; }
  export default function pdf(dataBuffer: Buffer): Promise<PdfResult>;
}
