import { estimateTokens } from "../domain/text";

/**
 * Structure-aware, deterministic chunking.
 *
 * Why this shape (the decision is recorded in plan.md):
 *  - Split on document structure first (headings / pages) so a chunk never straddles two topics, and keep the heading
 *    path as the citation label ("Refund policy › Digital goods"). Users see *where* an answer came from.
 *  - Pack whole paragraphs up to a token target, splitting on sentences only when a paragraph is too large.
 *  - Add a small sentence-aligned overlap so an answer that straddles a boundary is still retrievable.
 *  - Deterministic: identical input ⇒ identical chunks ⇒ identical (document, ordinal) keys ⇒ idempotent re-ingestion.
 */
export type Section = { path: string[]; text: string };
export type ChunkDraft = { ordinal: number; headingPath: string; content: string; tokenCount: number };

export type ChunkOptions = { targetTokens: number; maxTokens: number; overlapTokens: number; minTokens: number };
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { targetTokens: 450, maxTokens: 620, overlapTokens: 70, minTokens: 60 };

export const HEADING_SEPARATOR = " › ";

const FENCE = /^\s*(```|~~~)/;
const ATX_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Split markdown/plain text into sections by heading. `#` lines inside code fences are not headings. */
export function sectionizeText(text: string, rootLabel?: string): Section[] {
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let buf: string[] = [];
  let inFence = false;

  const path = () => [...(rootLabel ? [rootLabel] : []), ...stack.map((s) => s.title)];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) sections.push({ path: path(), text: body });
    buf = [];
  };

  for (const line of text.split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    const m = !inFence ? ATX_HEADING.exec(line) : null;
    if (m) {
      flush();
      const level = m[1]!.length;
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title: m[2]!.trim() });
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

const SENTENCE_SPLIT = /(?<=[.!?…])["')\]]?\s+(?=[A-Z0-9"“‘(\[])/;

function splitSentences(paragraph: string): string[] {
  return paragraph.split(SENTENCE_SPLIT).map((s) => s.trim()).filter(Boolean);
}

/** Last-resort split of an over-long unbroken run at word boundaries. */
function hardSplit(text: string, maxTokens: number): string[] {
  const maxChars = maxTokens * 4;
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(" ", maxChars);
    if (cut < maxChars * 0.5) cut = maxChars; // no usable space: split mid-token rather than loop forever
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** A packing unit. `newPara` records whether it starts a paragraph so re-joining never invents paragraph breaks. */
type Unit = { text: string; newPara: boolean };

function toUnits(sectionText: string, maxTokens: number): Unit[] {
  const units: Unit[] = [];
  for (const para of sectionText.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    if (estimateTokens(para) <= maxTokens) {
      units.push({ text: para, newPara: true });
      continue;
    }
    let first = true;
    for (const sentence of splitSentences(para)) {
      const parts = estimateTokens(sentence) <= maxTokens ? [sentence] : hardSplit(sentence, maxTokens);
      for (const part of parts) {
        units.push({ text: part, newPara: first });
        first = false;
      }
    }
  }
  return units;
}

const joinUnits = (units: Unit[]): string =>
  units.reduce((acc, u, i) => (i === 0 ? u.text : `${acc}${u.newPara ? "\n\n" : " "}${u.text}`), "");

/** Trailing sentences of `text` totalling ≤ `tokens`, used as overlap. Empty if even one sentence is too large. */
function overlapTail(text: string, tokens: number): string {
  if (tokens <= 0) return "";
  const sentences = splitSentences(text);
  const picked: string[] = [];
  let total = 0;
  for (let i = sentences.length - 1; i >= 0; i--) {
    const t = estimateTokens(sentences[i]!);
    if (total + t > tokens) break;
    picked.unshift(sentences[i]!);
    total += t;
  }
  return picked.join(" ");
}

export function chunkSections(sections: Section[], options: Partial<ChunkOptions> = {}): ChunkDraft[] {
  const o = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  if (o.overlapTokens >= o.targetTokens) throw new Error("overlapTokens must be smaller than targetTokens");
  const drafts: ChunkDraft[] = [];

  for (const section of sections) {
    const headingPath = section.path.join(HEADING_SEPARATOR);
    const bodies: string[] = [];
    let current: Unit[] = [];
    let currentTokens = 0;
    let carried = ""; // overlap text prefixed to the next chunk

    const flush = () => {
      if (!current.length) return;
      const body = joinUnits(current);
      bodies.push(carried ? `${carried}\n\n${body}` : body);
      carried = overlapTail(body, o.overlapTokens);
      current = [];
      currentTokens = 0;
    };

    for (const unit of toUnits(section.text, o.maxTokens - o.overlapTokens)) {
      const t = estimateTokens(unit.text);
      if (current.length && currentTokens + t > o.targetTokens) flush();
      current.push(unit);
      currentTokens += t;
    }
    flush();

    // Fold a tiny trailing chunk into its predecessor when that stays within the hard maximum.
    if (bodies.length > 1) {
      const last = bodies[bodies.length - 1]!;
      const prev = bodies[bodies.length - 2]!;
      if (estimateTokens(last) < o.minTokens && estimateTokens(prev) + estimateTokens(last) <= o.maxTokens) {
        bodies.splice(bodies.length - 2, 2, `${prev}\n\n${last}`);
      }
    }

    for (const content of bodies) {
      drafts.push({ ordinal: drafts.length, headingPath, content, tokenCount: estimateTokens(content) });
    }
  }
  return drafts;
}

/** Text that is embedded / indexed: heading context first, so short chunks still carry their topic. */
export const embeddingInput = (c: Pick<ChunkDraft, "headingPath" | "content">): string =>
  c.headingPath ? `${c.headingPath}\n${c.content}` : c.content;
