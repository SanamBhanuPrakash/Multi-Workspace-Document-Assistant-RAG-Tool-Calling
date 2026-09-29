const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

const TAGS = /<[^>]+>/g;

/**
 * Minimal HTML → markdown for mammoth output (headings, paragraphs, lists).
 * The result is plain TEXT that is chunked and embedded; it is never rendered as HTML, so this is not a sanitiser and
 * does not need to be one.
 */
export function htmlToMarkdown(html: string): string {
  return html
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => `\n\n${"#".repeat(Number(level))} ${inner.replace(TAGS, "").trim()}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${inner.replace(TAGS, "").trim()}`)
    .replace(/<\/(p|div|tr|ul|ol|table)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(TAGS, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
