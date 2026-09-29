/**
 * Text hygiene applied to every document BEFORE hashing, chunking or embedding.
 *
 * Besides tidying whitespace this removes characters that are invisible to a human reviewer but visible to a model:
 * Unicode "tag" characters (U+E0000–E007F, a known channel for hidden prompt-injection payloads), zero-width and
 * bidi-control characters, and C0 control characters. The number removed is returned so the injection scanner can
 * flag the document — hidden text in an upload is itself a signal.
 */
const HIDDEN_UNICODE = /[\u{E0000}-\u{E007F}​-‏‪-‮⁠-⁤⁦-⁩﻿­]/gu;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export type NormalizedText = { text: string; hiddenCharCount: number };

export function normalizeText(raw: string): NormalizedText {
  let hidden = 0;
  const stripped = raw.replace(HIDDEN_UNICODE, () => {
    hidden++;
    return "";
  });
  const text = stripped
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, "")
    .replace(/[ \t]+\n/g, "\n") // trailing spaces
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, hiddenCharCount: hidden };
}

/** Cheap, deterministic token estimate (≈ 4 chars/token for English). Used for sizing, never for billing. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** SHA-256 hex via Web Crypto (present in Node ≥ 20, edge and browsers) — keeps core free of Node imports. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Collapse an untrusted single-line label (filename, title, heading) so it cannot break prompt framing or the UI. */
export function sanitizeLabel(value: string, max = 120): string {
  return value
    .replace(HIDDEN_UNICODE, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(CONTROL_CHARS, "")
    .replace(/[<>"`]/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);
}
