/**
 * Seed the throwaway demo account with sample workspaces and documents, through the REAL ingestion pipeline.
 * Idempotent: re-running creates nothing new (users and documents are de-duplicated). `--reset` wipes the demo user's workspaces first.
 *
 * usage: npx tsx --conditions=react-server --env-file=.env scripts/seed.ts [--reset]
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { processIngestion, registerDocument } from "../src/core/application/ingest";
import { resolveTenantScope } from "../src/core/security/tenant";
import { ingestDeps } from "../src/infra/container";
import { closePool, withSystem } from "../src/infra/db/client";
import { membershipLookup } from "../src/infra/db/repositories";
import { workspaceRepo } from "../src/infra/db/queries";
import { account, user, workspaces } from "../src/infra/db/schema";
import { parseUpload } from "../src/infra/parsers";
import { DEMO_ACCOUNT } from "../src/ui/demo-account";

const FIX = join(process.cwd(), "fixtures");
const PLAN: { name: string; files: string[] }[] = [
  { name: "Acme Corp", files: ["docs/acme-handbook.md", "docs/acme-security-policy.md"] },
  { name: "Beta Labs", files: ["docs/beta-onboarding.md", "docs/beta-incident-runbook.md"] },
  { name: "Security Lab", files: ["adversarial/vendor-notes-INJECTION-TEST.md"] },
];

async function ensureDemoUser(): Promise<string> {
  const existing = await withSystem((tx) => tx.select({ id: user.id }).from(user).where(eq(user.email, DEMO_ACCOUNT.email)).limit(1));
  if (existing[0]) return existing[0].id;
  const id = randomUUID();
  const passwordHash = await hashPassword(DEMO_ACCOUNT.password);
  await withSystem(async (tx) => {
    await tx.insert(user).values({ id, name: "Demo Reviewer", email: DEMO_ACCOUNT.email, emailVerified: true });
    await tx.insert(account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: passwordHash });
  });
  return id;
}

async function main() {
  const reset = process.argv.includes("--reset");
  const userId = await ensureDemoUser();
  if (reset) {
    await withSystem((tx) => tx.delete(workspaces).where(eq(workspaces.ownerId, userId)));
    console.warn("reset: demo workspaces removed");
  }
  const existing = await workspaceRepo.listForUser(userId);
  for (const plan of PLAN) {
    const ws = existing.find((w) => w.name === plan.name) ?? (await workspaceRepo.create(userId, plan.name));
    const scope = await resolveTenantScope(membershipLookup, userId, ws.id);
    for (const file of plan.files) {
      const bytes = new Uint8Array(readFileSync(join(FIX, file)));
      const parsed = await parseUpload({ filename: file.split("/").pop()!, bytes });
      const deps = ingestDeps();
      const { document, created } = await registerDocument(deps, scope, parsed);
      const out = await processIngestion(deps, scope, document.id, { budgetMs: 120_000 });
      console.warn(`${plan.name.padEnd(12)} ${file.padEnd(48)} ${created ? "created " : "exists  "} -> ${out.state}${out.state === "ready" ? ` (${out.chunks} chunks, ${out.flagged} flagged)` : ""}`);
    }
  }
  console.warn(`\ndemo account: ${DEMO_ACCOUNT.email}`);
  await closePool();
}

main().catch(async (err: unknown) => {
  console.error("seed failed:", err instanceof Error ? err.message : err);
  await closePool();
  process.exit(1);
});
