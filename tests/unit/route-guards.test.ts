import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural guard over every API route (found by a manual security review, kept as a permanent test):
 *  - every tenant route is built with `workspaceRoute` (membership verified BEFORE the handler runs);
 *  - every mutating verb carries `mutating: true` (the same-origin / CSRF check is opt-in per route, so forgetting it is silent);
 *  - the only handlers allowed outside the wrappers are the auth catch-all and the health probe.
 */
const ROOT = join(process.cwd(), "src", "app", "api");
const UNWRAPPED_ALLOWED = new Set(["auth/[...all]/route.ts", "health/route.ts"]);

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name === "route.ts" ? [join(dir, e.name)] : []));
const rel = (f: string) => f.slice(ROOT.length + 1).replaceAll("\\", "/");

describe("API route guards", () => {
  const files = walk(ROOT);

  it("finds the routes (sanity: the walker is not silently empty)", () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it("every handler is wrapped, except the auth catch-all and health probe", () => {
    const unwrapped = files.filter((f) => !UNWRAPPED_ALLOWED.has(rel(f)) && !/export const (GET|POST|PUT|PATCH|DELETE) = (publicRoute|userRoute|workspaceRoute)/.test(readFileSync(f, "utf8"))).map(rel);
    expect(unwrapped).toEqual([]);
  });

  it("every mutating verb sets `mutating: true` (origin check)", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/export const (POST|PUT|PATCH|DELETE) = (\w+)(?:<[^>]*>)?\(\{([^}]*)\}/g)) {
        if (!/mutating:\s*true/.test(m[3]!)) offenders.push(`${m[1]} ${rel(f)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("everything under /api/w/[id] uses workspaceRoute, never a weaker wrapper", () => {
    const weak = files
      .filter((f) => rel(f).startsWith("w/"))
      .filter((f) => /export const \w+ = (publicRoute|userRoute)/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(weak).toEqual([]);
  });

  it("no route exports a raw, unwrapped mutating handler (e.g. `export async function POST`)", () => {
    const raw = files.filter((f) => !UNWRAPPED_ALLOWED.has(rel(f)) && /export (async )?function (POST|PUT|PATCH|DELETE)\b/.test(readFileSync(f, "utf8"))).map(rel);
    expect(raw).toEqual([]);
  });
});
