import type { EmbeddingPort } from "@/core/ports/providers";
import { EMBEDDING_DIMENSIONS } from "../db/schema";

/**
 * Deterministic OFFLINE embedder for local development and tests (never used in production — env.ts refuses it there).
 * Hashed bag-of-words + bigrams into 768 dims, L2-normalised: cosine similarity tracks lexical overlap, so retrieval,
 * ranking and the relevance gate behave sensibly without any API key or network.
 */
const STOP = new Set(
  "a an and are as at be but by for from has have how i if in is it its of on or that the their there this to was what when where which who why will with you your do does did can could should would about into than then them they we our not no yes".split(" "),
);

const stem = (w: string): string => (w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

export const tokenize = (text: string): string[] =>
  (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? []).map(stem).filter((w) => w.length > 1 && !STOP.has(w));

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function fakeEmbedOne(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const toks = tokenize(text);
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i]!;
    v[fnv1a(w) % EMBEDDING_DIMENSIONS]! += 1;
    if (i + 1 < toks.length) v[fnv1a(`${w} ${toks[i + 1]}`) % EMBEDDING_DIMENSIONS]! += 0.5;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) {
    v[0] = 1; // empty/stopword-only text: a fixed unit vector, so cosine distance is always defined
    return v;
  }
  return v.map((x) => x / norm);
}

export class FakeEmbedding implements EmbeddingPort {
  readonly model = "fake-hash-768";
  readonly dimensions = EMBEDDING_DIMENSIONS;
  async embed(texts: string[], _kind?: "document" | "query"): Promise<number[][]> {
    return texts.map(fakeEmbedOne);
  }
}
