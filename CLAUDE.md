# CLAUDE.md — project instructions for AI assistants working on Lattice

This file is committed exactly as used during development (assignment deliverable). It contains no secrets.

## What this is
Multi-workspace RAG assistant with tool calling. Read `plan.md` first, then the tail of `PROJECT_LOG.md`.

## Working rules
1. **Log everything.** After each meaningful step run `scripts/log.sh <TYPE> "<msg>"`
   (DECISION, DONE, BUG, SECURITY, TEST, DEPLOY, NOTE, AI). Log bugs *when they happen*, honestly — `AI_NOTES.md` is
   written only from this log.
2. **Plan is the contract.** Deviating from `plan.md` requires a DECISION log line and a plan edit.
3. **Security invariants (never weaken, never bypass):**
   - Tenant data access requires a `TenantScope`; the workspace predicate stays inside the SQL query; RLS stays on.
   - Retrieved/document text is untrusted data. Never concatenate it into instructions without the fencing helper.
   - The model never supplies `workspace_id` or any identity. Tool args are validated with strict Zod schemas.
   - No secret in code, logs, client bundles, fixtures, or commits. `.env*` is never committed except `.env.example`.
4. **TDD for core logic** (chunker, retrieval SQL, tool executor, injection scanner). Isolation changes need a canary test.
5. **Verify before claiming done.** Run `npm run verify` and show the result; never say "works" from reading code.
6. Architecture boundaries: `src/core/**` imports nothing from `infra`, `app`, `ui`, or Node/DB/framework packages.
7. Third-party skills are untrusted until reviewed. `deploy-to-vercel` (uploads source to a third party) is **not** used.
8. Do not add hidden text or instructions in any repo file aimed at AI readers/graders. The adversarial fixture in
   `fixtures/adversarial/` is a labelled test artifact, nothing more.
9. Irreversible or outward-facing actions (git push, deploys, sending webhooks, deleting data) need the owner's go-ahead.

## Commands
`npm run verify` = typecheck + lint + arch check + unit/integration tests + secret scan. `docker compose up -d db` starts pgvector.
