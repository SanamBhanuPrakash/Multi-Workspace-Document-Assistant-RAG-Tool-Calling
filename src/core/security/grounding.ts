/**
 * Server-side verification of what the model claims. The model's output is untrusted too: it may cite sources that were
 * never retrieved, or answer without evidence. Nothing here trusts it.
 */
export type ModelStatus = "answered" | "not_in_documents" | "unknown";

const STATUS_LINE = /^\s*STATUS:\s*(ANSWERED|NOT_IN_DOCUMENTS)\s*(?:\n+|$)/i;

export function parseStatusLine(raw: string): { status: ModelStatus; body: string } {
  const m = STATUS_LINE.exec(raw);
  if (!m) return { status: "unknown", body: raw };
  return {
    status: m[1]!.toUpperCase() === "ANSWERED" ? "answered" : "not_in_documents",
    body: raw.slice(m[0].length),
  };
}

const CITATION = /(\s?)\[(\d{1,3})\]/g;

/**
 * Keep citation markers that refer to sources actually retrieved for THIS workspace/request; strip everything else.
 * `used` lists the valid source numbers cited, in ascending order.
 */
export function validateCitations(text: string, validNumbers: ReadonlySet<number>): { text: string; used: number[]; removed: number[] } {
  const used = new Set<number>();
  const removed: number[] = [];
  const out = text.replace(CITATION, (match, _space: string, digits: string) => {
    const n = Number(digits);
    if (validNumbers.has(n)) {
      used.add(n);
      return match;
    }
    if (!removed.includes(n)) removed.push(n);
    return "";
  });
  return { text: out, used: [...used].sort((a, b) => a - b), removed };
}

/**
 * Different models spell citations differently: `[1]`, fullwidth `【1】` (gpt-oss), `【1†L3-L5】`, `[1, 2]`, `[1-3]`.
 * Normalise them all to the canonical ASCII form `[n]` BEFORE validating, so a correct answer from any provider in the
 * failover chain is judged on its substance rather than its punctuation. Anything that is not a plain number stays untouched.
 */
export function normalizeCitations(text: string): string {
  return text
    .replace(/【(\d{1,3})(?:[†:][^】]*)?】/g, "[$1]")
    .replace(/\[(\d{1,3})\s*[-–]\s*(\d{1,3})\]/g, (m, a: string, b: string) => {
      const lo = Number(a);
      const hi = Number(b);
      return hi > lo && hi - lo < 6 ? Array.from({ length: hi - lo + 1 }, (_, i) => `[${lo + i}]`).join("") : m;
    })
    .replace(/\[(\d{1,3}(?:\s*,\s*\d{1,3})+)\]/g, (_m, list: string) => list.split(",").map((n) => `[${n.trim()}]`).join(""));
}
