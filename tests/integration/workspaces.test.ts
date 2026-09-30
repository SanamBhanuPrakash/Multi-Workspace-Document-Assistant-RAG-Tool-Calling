import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { workspaceRepo } from "@/infra/db/queries";
import { closePool, DbError, withSystem, withUser } from "@/infra/db/client";
import { pgCode } from "@/infra/db/repositories";
import { chunks } from "@/infra/db/schema";
import { makeUser } from "../helpers/db";

afterAll(() => closePool());

describe("workspace bootstrap & creation under concurrency", () => {
  it("REGRESSION: N concurrent first-visits create EXACTLY ONE default workspace (found by the browser suite)", async () => {
    const u = await makeUser("first-visit");
    // /app renders twice at once (prefetch + navigation); simulate a burst of 12.
    const results = await Promise.all(Array.from({ length: 12 }, () => workspaceRepo.ensureFirst(u)));
    expect(new Set(results.map((r) => r.map((w) => w.id).join())).size).toBe(1);
    expect(await workspaceRepo.listForUser(u)).toHaveLength(1);
  });

  it("REGRESSION: /app rendering twice for many brand-new users never surfaces a unique-violation (confirmed root cause of the e2e sign-up failure)", async () => {
    // A single 12-way burst did NOT reproduce the bug (it passed without the lock). The real trigger is two overlapping
    // requests per fresh user, so exercise many users x 3 overlapping calls and require that none rejects.
    const users = await Promise.all(Array.from({ length: 25 }, (_, i) => makeUser(`fresh-${i}`)));
    const settled = await Promise.allSettled(users.flatMap((u) => [1, 2, 3].map(() => workspaceRepo.ensureFirst(u))));
    const failures = settled.filter((s) => s.status === "rejected").map((s) => String((s as PromiseRejectedResult).reason));
    expect(failures).toEqual([]);
    for (const u of users) expect(await workspaceRepo.listForUser(u)).toHaveLength(1);
  });

  it("ensureFirst is a no-op once the user has a workspace", async () => {
    const u = await makeUser("has-ws");
    const w = await workspaceRepo.create(u, "Existing");
    const out = await workspaceRepo.ensureFirst(u);
    expect(out.map((x) => x.id)).toEqual([w.id]);
  });

  it("concurrent creates with the SAME name all succeed with distinct slugs (no unique-violation 500)", async () => {
    const u = await makeUser("same-name");
    const made = await Promise.all(Array.from({ length: 6 }, () => workspaceRepo.create(u, "Research")));
    expect(new Set(made.map((w) => w.slug)).size).toBe(6);
    expect(made.map((w) => w.slug).sort()[0]).toMatch(/^research/);
  });

  it("assigns rotating identity colours", async () => {
    const u = await makeUser("colours");
    const a = await workspaceRepo.create(u, "One");
    const b = await workspaceRepo.create(u, "Two");
    expect(a.color).not.toBe(b.color);
  });
});

describe("database errors never carry bound parameters", () => {
  it("a failing statement surfaces as DbError: SQLSTATE + constraint kept, parameters gone", async () => {
    const secretText = "SUPER-SECRET-DOCUMENT-TEXT-12345";
    const err = await withSystem((tx) =>
      tx.insert(chunks).values({ workspaceId: "00000000-0000-4000-8000-000000000000", documentId: "00000000-0000-4000-8000-000000000001", ordinal: 0, content: secretText, tokenCount: 1, embedding: new Array<number>(768).fill(0), embeddingModel: "t" }),
    ).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).message).not.toContain(secretText);
    expect((err as DbError).message).not.toContain("params:");
    expect((err as DbError).code).toBe("23503"); // foreign_key_violation survives, so callers can still branch on it
    expect(pgCode(err)).toBe("23503");
  });

  it("user-scoped transactions sanitise too", async () => {
    const u = await makeUser("err");
    const err = await withUser(u, (tx) => tx.execute(sql`SELECT 1/0 AS boom`)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect(pgCode(err)).toBe("22012"); // division_by_zero
  });
});
