import "server-only";
import { DomainError } from "@/core/domain/errors";
import type { ParsedDocument } from "@/core/application/ingest";
import { htmlToMarkdown } from "./html-to-markdown";

/**
 * Upload parsing. Files are hostile input:
 *  - the TYPE is decided by content (magic bytes), never by the extension or client-supplied MIME;
 *  - hard limits on bytes, ZIP entry count / declared expansion (DOCX is a ZIP: decompression-bomb defence), PDF pages;
 *  - all output is plain text/markdown that then goes through normalizeText (hidden-Unicode stripping) in registerDocument.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_PDF_PAGES = 250;
const MAX_ZIP_ENTRIES = 300;
const MAX_ZIP_DECLARED_BYTES = 60 * 1024 * 1024;

export type UploadInput = { filename: string; bytes: Uint8Array };

const startsWith = (b: Uint8Array, sig: number[]): boolean => sig.every((v, i) => b[i] === v);
const isPdf = (b: Uint8Array) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
const isZip = (b: Uint8Array) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04

/** Reads the ZIP central directory and totals DECLARED uncompressed sizes without inflating anything. */
export function inspectZip(bytes: Uint8Array): { entries: number; declaredBytes: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new DomainError("unsupported_media", "The file is not a valid .docx.", 415);
  const entries = dv.getUint16(eocd + 10, true);
  let offset = dv.getUint32(eocd + 16, true);
  let declaredBytes = 0;
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > bytes.length || dv.getUint32(offset, true) !== 0x02014b50) throw new DomainError("unsupported_media", "The file is corrupt.", 415);
    declaredBytes += dv.getUint32(offset + 24, true);
    offset += 46 + dv.getUint16(offset + 28, true) + dv.getUint16(offset + 30, true) + dv.getUint16(offset + 32, true);
  }
  return { entries, declaredBytes };
}

const stripExt = (name: string) => name.replace(/\.[^.]+$/, "");

function decodeText(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new DomainError("unsupported_media", "That looks like a binary file, not text.", 415);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DomainError("unsupported_media", "Text files must be UTF-8 encoded.", 415);
  }
}

export async function parseUpload({ filename, bytes }: UploadInput): Promise<ParsedDocument> {
  if (bytes.length === 0) throw new DomainError("validation", "The file is empty.", 422);
  if (bytes.length > MAX_UPLOAD_BYTES) throw new DomainError("payload_too_large", `Files are limited to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`, 413);
  const ext = (/\.([A-Za-z0-9]+)$/.exec(filename)?.[1] ?? "").toLowerCase();
  const base = { filename, sizeBytes: bytes.length };

  if (isPdf(bytes)) {
    if (ext && ext !== "pdf") throw new DomainError("unsupported_media", "File extension does not match its content.", 415);
    const { extractText, getDocumentProxy } = await import("unpdf");
    let pages: string[];
    try {
      const pdf = await getDocumentProxy(new Uint8Array(bytes)); // copy: pdf.js transfers the buffer
      if (pdf.numPages > MAX_PDF_PAGES) throw new DomainError("payload_too_large", `PDFs are limited to ${MAX_PDF_PAGES} pages.`, 413);
      pages = (await extractText(pdf, { mergePages: false })).text;
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new DomainError("unsupported_media", "That PDF could not be read (it may be encrypted or corrupt).", 415);
    }
    const text = pages.map((p, i) => `# Page ${i + 1}\n\n${p.trim()}`).filter((_, i) => pages[i]!.trim().length > 0).join("\n\n");
    if (!text.trim()) throw new DomainError("unsupported_media", "This PDF has no extractable text (scanned images are not supported).", 422);
    return { ...base, title: stripExt(filename), mime: "application/pdf", text };
  }

  if (isZip(bytes)) {
    if (ext !== "docx") throw new DomainError("unsupported_media", "Only .docx archives are supported.", 415);
    const { entries, declaredBytes } = inspectZip(bytes);
    if (entries > MAX_ZIP_ENTRIES || declaredBytes > MAX_ZIP_DECLARED_BYTES) throw new DomainError("payload_too_large", "That .docx expands to an unsafe size.", 413);
    const mammoth = (await import("mammoth")).default ?? (await import("mammoth"));
    try {
      const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
      const text = htmlToMarkdown(value);
      if (!text.trim()) throw new DomainError("unsupported_media", "That document has no text.", 422);
      return { ...base, title: stripExt(filename), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", text };
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new DomainError("unsupported_media", "That .docx could not be read.", 415);
    }
  }

  if (!["txt", "md", "markdown", "text", ""].includes(ext)) throw new DomainError("unsupported_media", "Supported types: PDF, DOCX, Markdown, plain text.", 415);
  const text = decodeText(bytes);
  const h1 = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  return { ...base, title: h1 && h1.length <= 120 ? h1 : stripExt(filename), mime: ext === "md" || ext === "markdown" ? "text/markdown" : "text/plain", text };
}
