import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Supply-chain / hidden-instruction hygiene for OUR OWN repo. Invisible Unicode (tag characters, zero-width, bidi
 * controls) is a known channel for smuggling instructions to AI readers and for "Trojan Source" attacks. No committed
 * text file may contain any — code that needs to match them must use visible \\u escapes.
 * The adversarial fixture builds its hidden payload at runtime, so it is exempt from nothing.
 */
const HIDDEN = /[\u{E0000}-\u{E007F}\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD]/u;
const ROOTS = ["src", "tests", "scripts", "docs", "fixtures", "db"];
const TOP = ["README.md", "plan.md", "CLAUDE.md", "AI_NOTES.md", "PROJECT_LOG.md", "package.json", "next.config.ts", "proxy.ts"];
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|sql|css|yml|yaml|sh|txt)$/;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (TEXT.test(name)) yield p;
  }
}

describe("repository hygiene", () => {
  it("contains no invisible/bidi/tag characters in any tracked text file", () => {
    const offenders: string[] = [];
    const files = [...ROOTS.flatMap((r) => { try { return [...walk(r)]; } catch { return []; } }), ...TOP];
    for (const f of files) {
      let text: string;
      try { text = readFileSync(f, "utf8"); } catch { continue; }
      if (HIDDEN.test(text)) offenders.push(f);
    }
    expect(offenders, `hidden characters found in: ${offenders.join(", ")}`).toEqual([]);
  });
});
