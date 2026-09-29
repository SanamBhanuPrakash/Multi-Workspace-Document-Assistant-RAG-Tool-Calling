import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { parseUpload, inspectZip, MAX_UPLOAD_BYTES } from "@/infra/parsers";
import { htmlToMarkdown } from "@/infra/parsers/html-to-markdown";

const enc = (s: string) => new TextEncoder().encode(s);

async function makeDocx(bodyXml: string, extra: Record<string, string | Uint8Array> = {}): Promise<Uint8Array> {
  const z = new JSZip();
  z.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  z.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  z.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`);
  for (const [k, v] of Object.entries(extra)) z.file(k, v);
  return z.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
const para = (text: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t>${text}</w:t></w:r></w:p>`;

const MINI_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 52>>stream
BT /F1 18 Tf 20 100 Td (The vault code is ZEBRA-4417) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R/Size 6>>
%%EOF`;

describe("parseUpload — text", () => {
  it("uses the first H1 as the title for markdown", async () => {
    const r = await parseUpload({ filename: "notes.md", bytes: enc("# Handbook\n\nBody text that is long enough.") });
    expect(r).toMatchObject({ title: "Handbook", mime: "text/markdown" });
  });
  it("falls back to the filename for plain text", async () => {
    expect((await parseUpload({ filename: "policy.txt", bytes: enc("Plain policy text goes here.") })).title).toBe("policy");
  });
  it("rejects binary content and invalid UTF-8", async () => {
    await expect(parseUpload({ filename: "a.txt", bytes: new Uint8Array([104, 105, 0, 1, 2]) })).rejects.toMatchObject({ code: "unsupported_media" });
    await expect(parseUpload({ filename: "a.txt", bytes: new Uint8Array([0xff, 0xfe, 0xfa, 0x41]) })).rejects.toMatchObject({ code: "unsupported_media" });
  });
  it("rejects empty and oversized files", async () => {
    await expect(parseUpload({ filename: "a.txt", bytes: new Uint8Array(0) })).rejects.toMatchObject({ code: "validation" });
    await expect(parseUpload({ filename: "a.txt", bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1).fill(97) })).rejects.toMatchObject({ code: "payload_too_large" });
  });
  it("rejects unsupported extensions", async () => {
    await expect(parseUpload({ filename: "run.exe", bytes: enc("MZ not really but text") })).rejects.toMatchObject({ code: "unsupported_media" });
    await expect(parseUpload({ filename: "page.html", bytes: enc("<script>alert(1)</script>") })).rejects.toMatchObject({ code: "unsupported_media" });
  });
});

describe("parseUpload — type is decided by CONTENT, not name", () => {
  it("a PDF renamed .txt is refused (and vice versa)", async () => {
    await expect(parseUpload({ filename: "sneaky.txt", bytes: enc(MINI_PDF) })).rejects.toMatchObject({ code: "unsupported_media" });
  });
  it("a ZIP renamed .txt or .pdf is refused", async () => {
    const zip = await makeDocx(para("hi there"));
    await expect(parseUpload({ filename: "x.txt", bytes: zip })).rejects.toMatchObject({ code: "unsupported_media" });
    await expect(parseUpload({ filename: "x.pdf", bytes: zip })).rejects.toMatchObject({ code: "unsupported_media" });
  });
  it("a text file named .pdf/.docx is treated as text only if the extension is allowed for text", async () => {
    await expect(parseUpload({ filename: "x.docx", bytes: enc("just text but named docx") })).rejects.toMatchObject({ code: "unsupported_media" });
  });
});

describe("parseUpload — PDF", () => {
  it("extracts text and labels each page", async () => {
    const r = await parseUpload({ filename: "guide.pdf", bytes: enc(MINI_PDF) });
    expect(r.text).toContain("# Page 1");
    expect(r.text).toContain("ZEBRA-4417");
    expect(r.mime).toBe("application/pdf");
  });
  it("reports a corrupt PDF cleanly instead of throwing internals", async () => {
    await expect(parseUpload({ filename: "bad.pdf", bytes: enc("%PDF-1.4\nthis is not a pdf at all") })).rejects.toMatchObject({ code: "unsupported_media" });
  });
});

describe("parseUpload — DOCX", () => {
  it("converts headings and paragraphs to markdown structure", async () => {
    const docx = await makeDocx(para("Refund policy", "Heading1") + para("Customers may request a refund within 14 days.") + para("Digital goods", "Heading2") + para("Refundable only if unused."));
    const r = await parseUpload({ filename: "handbook.docx", bytes: docx });
    expect(r.text).toContain("# Refund policy");
    expect(r.text).toContain("14 days");
  });
  it("refuses a decompression bomb: tiny on disk, 61 MB declared", async () => {
    const bomb = await makeDocx(para("hi"), { "word/bomb.bin": new Uint8Array(61 * 1024 * 1024) });
    expect(bomb.length).toBeLessThan(MAX_UPLOAD_BYTES); // passes the byte limit…
    expect(inspectZip(bomb).declaredBytes).toBeGreaterThan(60 * 1024 * 1024);
    await expect(parseUpload({ filename: "bomb.docx", bytes: bomb })).rejects.toMatchObject({ code: "payload_too_large" }); // …but not the expansion limit
  });
  it("refuses a ZIP with too many entries", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 400; i++) many[`word/e${i}.xml`] = "x";
    await expect(parseUpload({ filename: "many.docx", bytes: await makeDocx(para("hi"), many) })).rejects.toMatchObject({ code: "payload_too_large" });
  });
  it("rejects a truncated/corrupt archive", async () => {
    const good = await makeDocx(para("hello world"));
    await expect(parseUpload({ filename: "cut.docx", bytes: good.slice(0, 60) })).rejects.toMatchObject({ code: "unsupported_media" });
  });
});

describe("htmlToMarkdown", () => {
  it("maps headings, lists, paragraphs; strips tags; decodes entities; never keeps <script>", () => {
    const md = htmlToMarkdown("<h1>Title</h1><p>A &amp; B</p><ul><li>one</li><li>two</li></ul><script>alert(1)</script>");
    expect(md).toContain("# Title");
    expect(md).toContain("A & B");
    expect(md).toContain("- one");
    expect(md).not.toContain("<");
  });
});
