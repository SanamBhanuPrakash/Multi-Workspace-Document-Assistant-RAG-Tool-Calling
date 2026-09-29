import * as React from "react";

/**
 * A deliberately small markdown renderer that emits React elements directly — never HTML strings.
 * Model output and document text are UNTRUSTED, so: no raw HTML, no links or images (no `javascript:` URLs, no tracking
 * pixels / markdown-image exfiltration), no `dangerouslySetInnerHTML`. Only headings, lists, code, emphasis and citations.
 */
export type CitationRenderer = (n: number) => React.ReactNode;

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[\d{1,3}\](?:\[\d{1,3}\])*)/g;

function inline(text: string, cite: CitationRenderer, keyBase: string): React.ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${keyBase}-${i}`;
    if (!part) return null;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={key} className="font-semibold text-ink">{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={key} className="rounded bg-panel-3 px-1 py-0.5 font-mono text-[0.9em] text-ink">{part.slice(1, -1)}</code>;
    if (/^\[\d/.test(part)) {
      const nums = [...part.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1]));
      return <React.Fragment key={key}>{nums.map((n) => <React.Fragment key={n}>{cite(n)}</React.Fragment>)}</React.Fragment>;
    }
    return <React.Fragment key={key}>{part}</React.Fragment>;
  });
}

export function Markdown({ text, cite }: { text: string; cite: CitationRenderer }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) buf.push(lines[i++]!);
      i++;
      blocks.push(<pre key={k++} className="overflow-x-auto rounded-md border border-line bg-panel-2 p-3 font-mono text-[13px] leading-relaxed text-ink">{buf.join("\n")}</pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(<p key={k++} className="mt-1 font-semibold text-ink">{inline(h[2]!, cite, `h${k}`)}</p>);
      i++;
      continue;
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*[-*•]\s+/, ""));
      blocks.push(<ul key={k++} className="list-disc space-y-1 pl-5 marker:text-ink-3">{items.map((it, j) => <li key={j}>{inline(it, cite, `u${k}-${j}`)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*\d+[.)]\s+/, ""));
      blocks.push(<ol key={k++} className="list-decimal space-y-1 pl-5 marker:text-ink-3">{items.map((it, j) => <li key={j}>{inline(it, cite, `o${k}-${j}`)}</li>)}</ol>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^\s*(```|#{1,4}\s|[-*•]\s|\d+[.)]\s)/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(<p key={k++}>{inline(para.join(" "), cite, `p${k}`)}</p>);
  }
  return <div className="space-y-3 break-words">{blocks}</div>;
}
