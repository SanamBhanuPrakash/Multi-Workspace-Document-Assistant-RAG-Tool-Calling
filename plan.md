# plan.md — Lattice: Multi-Workspace Document Assistant

> Living document. Every decision, phase change and deviation gets a dated line in `PROJECT_LOG.md`
> (`scripts/log.sh TYPE "msg"`). If this file and the log disagree, the log wins and this file is fixed.
> Created 2026-09-29.

## 0. Mission & bar

Build the assignment's core **correctly** (isolation, grounding, safe tools, injection resistance, resilience,
no leaked secrets), then go past it. Stakes are high; nothing is "good enough". Quality bar is set by the
assignment's own sentence: *"Treat this as something that will run unattended and be trusted with separate
tenants' data and with actions."*

Non-negotiables
1. Workspace predicate is **inside** the vector/keyword SQL — never post-filtered. Postgres RLS is an independent second wall.
2. Retrieved text is **data**. Tools are an allowlist. Workspace id **never** comes from model output.
3. State is written **before** any slow/unreliable call. Failure never loses the user's question.
4. No secret in repo, history, client bundle, logs, or error messages.
5. Everything on free tiers, no credit card.
6. Honesty: nothing in `AI_NOTES.md` that is not in `PROJECT_LOG.md`. No fabricated bugs.

## 1. Skills / tooling policy
Project-level skills in `.claude/skills/` (reviewed, see `docs/ASSIGNMENT_ANALYSIS.md` §4): superpowers (brainstorming,
writing-plans, TDD, systematic-debugging, verification-before-completion, requesting-code-review …),
ui-ux-pro-max, vercel react/composition/view-transitions/optimize, plus globally installed cloudflare security-audit,
web-design-guidelines, frontend-design, emil-design-eng, animate. Lenis = npm dep. Rejected: `deploy-to-vercel`.

## 2. Stack (and why)

| Concern | Choice | Reason |
|---|---|---|
| App | **Next.js 16 (App Router, RSC) + React 19 + TypeScript strict** | Single deployable, server components keep secrets server-side, streaming route handlers, first-class Vercel free host |
| Data | **Postgres 17 + pgvector** (Neon prod, Docker locally) | One shared `chunks` table; SQL gives us predicates, RLS, FTS and vectors in one statement |
| ORM/migrations | **Drizzle ORM + drizzle-kit** (+ hand-written SQL migrations for RLS/HNSW/functions) | Typed queries, but SQL stays visible for security-critical bits |
| Auth | **Better Auth** (email+password, scrypt, DB sessions, httpOnly cookies) | Maintained, TS-first, Drizzle adapter; no hand-rolled password/session code |
| Validation | **Zod 4** everywhere at trust boundaries | Tool args, API bodies, env, LLM structured output |
| LLM | **Gemini** via `@google/genai` behind `LlmPort`; **Groq** fallback adapter | Free, no card, tool calling; fallback for 429/outage |
| Embeddings | Gemini embedding (768-dim MRL, L2-normalised) behind `EmbeddingPort` | Free; dimension fixed in schema, model id stored per chunk for safe migration |
| Logging/metrics | **pino** (redaction) + `request_traces` table | Token counts, latency, hit/miss, tool outcomes without a paid APM |
| UI | **Tailwind v4 + Radix primitives (shadcn pattern) + Motion + Lenis**, tokens from ui-ux-pro-max | Accessible primitives, custom design system, no template look |
| Tests | **Vitest** (unit+integration on real pgvector), **Playwright** (E2E isolation), adversarial eval suite | Isolation is proven against a real DB, not mocks |
| CI | GitHub Actions: typecheck, lint, arch-boundary check, tests, gitleaks, `npm audit`, build | Same gates locally via `npm run verify` |
| Host | **Vercel Hobby** (app) + **Neon** (db) | No card. Long work is resumable to respect function limits |

## 3. Architecture (hexagonal, enforced)

```
src/
  core/                    # pure TS, ZERO framework/IO imports (enforced by dependency-cruiser)
    domain/                # Workspace, Document, Chunk, Citation, ToolCall, policies, errors
    ports/                 # LlmPort, EmbeddingPort, ChunkStorePort, NotifierPort, Clock, IdGen …
    application/           # use-cases: IngestDocument, AskQuestion, ExecuteTool, ShareDocument …
    security/              # TenantScope (branded), untrusted-data fencing, injection scanner, taint
  infra/                   # adapters: db/ (drizzle, rls), llm/gemini, llm/groq, embed/gemini,
                           # notify/slack|discord, crypto/, logging/, ratelimit/
  app/                     # Next.js routes, server actions, route handlers (thin — parse, authorise, delegate)
  ui/                      # design system + feature components
```

**Tenant boundary as a type.** `TenantScope = { userId, workspaceId }` is a branded type, constructible only by
`resolveTenantScope(session, workspaceId)`, which verifies membership. Every repository/port method that touches
tenant data takes a `TenantScope` as its first parameter — you cannot call the vector store without one.

**Defence in depth for isolation (4 layers)**
1. *Type layer* — `TenantScope` required.
2. *Query layer* — `WHERE c.workspace_id = $scope` in the same statement as `ORDER BY embedding <=> $q` (and in the FTS branch).
3. *Database layer* — RLS on every tenant table. App connects as `app_user` (no BYPASSRLS); each transaction runs
   `SET LOCAL app.workspace_id = …`. A bug in layers 1–2 still returns zero foreign rows.
4. *Verification layer* — canary tests (distinctive fact in A, never surfaces in B via chat, tools, debug view,
   history, caches) run in CI; retrieval-debug view shows an "isolation proof" strip per answer.

**ANN + filter pitfall (documented in README).** HNSW with a selective `WHERE` post-filters and can return < k rows.
Mitigations: `hnsw.iterative_scan = relaxed_order`, btree on `workspace_id`, and for small per-workspace corpora the
planner uses an exact scan within the workspace. Verified by a test that a tiny workspace still gets its k results
while a huge neighbour workspace exists.

### 3.1 Data model (one shared store)
`users, sessions, accounts` (Better Auth) · `workspaces` · `memberships(role)` · `documents(workspace_id, content_hash,
status, error, UNIQUE(workspace_id, content_hash))` · **`chunks(workspace_id NOT NULL, document_id, ordinal, heading_path,
content, token_count, embedding vector(768), embedding_model, tsv tsvector, UNIQUE(document_id, ordinal))`** ·
`ingestion_jobs` · `conversations` · `messages(status: pending|streaming|complete|failed)` · `tool_calls(name, raw_args,
validated_args, status: proposed|rejected|awaiting_confirmation|running|succeeded|failed, result, error, latency_ms,
idempotency_key, tainted)` · `tasks` · `workspace_integrations(webhook encrypted AES-256-GCM)` · `retrieval_events`
(query, workspace, chunk ids, vector/keyword ranks, scores) · `request_traces(tokens_in/out, latency, hit/miss, provider)` ·
`document_shares(document_id, target_workspace_id)` · `audit_log` · `rate_limits`.

### 3.2 Ingestion pipeline (idempotent, resumable)
upload → size/type/magic-byte checks → parse (txt/md/pdf/docx) → normalise → SHA-256 content hash →
`INSERT … ON CONFLICT (workspace_id, content_hash)` (dup ⇒ return existing) → `ingestion_jobs` row → structure-aware
chunking (heading-aware, ~500 tokens, 80 overlap, sentence-safe, heading path kept as citation label) → embed in batches
with checkpointing → upsert chunks on `(document_id, ordinal)` → injection-scan each chunk (flag, never drop silently)
→ status `ready`. Failure leaves job `failed` + retry; a sweeper resumes stalled jobs when the dashboard loads
(Vercel Hobby has no sub-daily cron).

### 3.3 RAG pipeline (per question)
persist user msg + pending assistant msg → rate-limit → **condense** follow-up into standalone query (workspace-scoped
history only) → embed query → **hybrid retrieval in one SQL statement** (vector top-N ∪ FTS top-N, both filtered by
workspace, fused by RRF, then MMR de-dup) → relevance gate (if best evidence < threshold ⇒ deterministic "I don't know"
without calling the LLM) → prompt with fenced untrusted context (random nonce delimiters, chunk ids) → generate
(stream) → **server-side citation validation** (every `[n]` must map to a retrieved chunk of this workspace; unknown
markers stripped, uncited factual answers downgraded) → persist + trace.

### 3.4 Tool loop (model proposes, app disposes)
Registry of `{name, description, zodSchema, sideEffect, run(scope, args)}`. Tools: `save_task`, `list_tasks`,
`send_summary` (Slack/Discord webhook, host allow-listed, SSRF-safe), `search_documents` (enables multi-step
retrieval). Loop ≤ 5 iterations, per-call timeout, total budget. For each proposed call: unknown tool ⇒ typed error
result back to model; `strict()` Zod parse fail ⇒ typed error back; success ⇒ idempotency key
`hash(assistant_msg_id, name, canonical(args))` so retries never double-fire. **Taint tracking:** if any chunk in
context was flagged by the injection scanner, side-effect tools stop at `awaiting_confirmation` and the UI asks the
human. `workspace_id` is injected by the app from `TenantScope`; a model-supplied `workspace_id` is a schema error.

### 3.5 Prompt-injection posture
Fencing + nonce, "data not instructions" system rule, tool allowlist + schema, no tool has destructive scope,
taint → human confirmation, output citation validation, ingestion-time heuristic scanner (+ visible badge in UI),
adversarial fixture set in CI (`fixtures/adversarial/`), and a test that the injected `delete_everything` request
results in a `rejected` tool-log row and no side effects.

## 4. Security baseline
Argon/scrypt via Better Auth · `__Host-` httpOnly Secure SameSite=Lax cookies · Origin check on mutations ·
CSP with nonces, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` · Postgres-backed sliding-window
rate limits (per user, per IP, per workspace, per LLM cost) · upload limits + magic-byte sniffing · env validated by Zod
at boot (fail fast) · secrets only server-side, `server-only` import guard, pino redaction of keys/webhooks/cookies ·
webhook URLs AES-256-GCM encrypted at rest, never returned to client after save · uniform error envelope (no stack traces) ·
gitleaks pre-commit + CI · `npm audit` gate · Cloudflare security-audit skill pass in Phase 7 with report in `docs/`.

## 5. UX / design direction
Design system generated with ui-ux-pro-max (tokens, type, motion), then hand-built. Principles: calm, dense, trustworthy
"security console" feel; workspace identity is always visible (colour + name in the header, chat, debug view) so isolation
is *felt*. Lenis smooth scroll on marketing surfaces; app panes use native scroll for accessibility. Command palette
(⌘K) workspace switcher, optimistic UI, streaming tokens with citation chips, tool-call cards with live status,
retrieval inspector drawer, empty/error/loading states designed for every view, keyboard-first, WCAG 2.2 AA,
`prefers-reduced-motion` honoured, mobile-first responsive.

## 6. Stretch goals — all targeted
Retrieval-debug view ✔ plan · hybrid search + RRF (+ note on workspace-filter interaction) ✔ · token streaming ✔ ·
multi-step tools ✔ · opt-in cross-workspace document sharing ✔ (join-based, default deny) · observability dashboard ✔ ·
beyond: taint-based confirmation, isolation-proof strip, eval harness with adversarial corpus, audit log.

## 7. Phases & exit criteria

| Phase | Deliverable | Exit criterion |
|---|---|---|
| P0 | Recon, analysis, skills, plan, log | This file + `ASSIGNMENT_ANALYSIS.md` committed |
| P1 | Repo scaffold, tooling, env validation, Docker pgvector, schema+RLS migrations, auth, `TenantScope` | `npm run verify` green; RLS test proves cross-tenant read = 0 rows |
| P2 | Ingestion pipeline + idempotency + jobs | Re-upload ⇒ 0 new chunks; killed mid-job resumes |
| P3 | Hybrid retrieval, RAG, citations, IDK | Canary isolation test green; IDK eval set passes |
| P4 | Tool loop, registry, taint, confirmations | Malformed/unknown/injected calls all safe in tests |
| P5 | Design system, landing (Lenis), dashboard, chat streaming, docs/tools/debug/observability views | Playwright happy path + isolation E2E green |
| P6 | Sharing, eval harness, provider fallback, rate limits | Stretch checklist complete |
| P7 | Security hardening + Cloudflare audit + fixes | Audit report in `docs/SECURITY_AUDIT.md`, all high/medium fixed |
| P8 | Deploy (Vercel+Neon), seed demo data, README, TESTING.md, AI_NOTES.md, .env.example | Live URL passes scripted E2E against production |
| P9 | Final verification-before-completion pass | Checklist in §8 fully ticked with evidence |

## 8. Submission checklist (tick only with evidence in the log)
- [ ] Public URL, sign-in works, cold start acceptable
- [ ] ≥2 workspaces preloaded, switcher works, uploads scoped
- [ ] One shared `chunks` table (no per-workspace tables/indexes)
- [ ] ≥2 docs ingested, chunked, embedded, tagged
- [ ] Grounded chat with citations, IDK works
- [ ] ≥2 tools, real side effect (`save_task`), args validated
- [ ] Dashboard: documents, chat history, tool log, switcher
- [ ] Isolation canary passes live (fact in A absent in B)
- [ ] Injection fixture defeated live
- [ ] Idempotent re-upload; LLM failure keeps state
- [ ] No secrets in repo/history/client/logs (gitleaks clean)
- [ ] README (run locally, env vars, deploy), `.env.example`, test instructions + throwaway login
- [ ] `CLAUDE.md`/context files committed as used; `AI_NOTES.md` from real log
- [ ] Clean commit history

## 9. Open items needing the owner (cannot be done by the assistant)
Gemini API key (AI Studio) · Neon project (connection string) · Vercel account link · GitHub repo + push permission ·
optional Slack/Discord webhook. Development proceeds with fake providers + local Docker until these arrive.

## 10. STATUS & RESUME POINT (updated 2026-09-30, end of session 2)

**Everything buildable without the owner's accounts is done and committed locally (nothing pushed):** full app + stretch goals; `npm run verify` green (245 unit+integration tests); browser e2e 27/27; live eval 17/17 on real Gemini+Groq (6/6 cross-workspace refusals); CI workflow + gitleaks (history clean; untested on GitHub); focused security review with 4 findings fixed test-first; docs: README, TESTING, AI_NOTES, docs/{SECURITY,SECURITY_AUDIT,EVALS,ASSIGNMENT_ANALYSIS}.

**What is left (all need the owner):**
1. **Deploy:** Neon (direct URL for `db:migrate`+`seed`, pooled URL for the app; UNVERIFIED that the owner role may `CREATE ROLE lattice_app` / `GRANT ... TO CURRENT_USER`), Vercel project + env vars (`APP_URL` must equal the production origin), smoke-test the live URL with TESTING.md sections A-D, check headers/`Secure` cookie/X-Forwarded-For behaviour. Then put the live URL in README.
2. **Before handing in:** `npm run seed -- --reset` on the dev DB (it still holds my eval conversations) and on the production DB; rotate the Gemini/Groq keys (they were pasted in chat).
3. **Push:** owner pushes to GitHub themselves (I must NOT push). Local commits carry `Co-Authored-By: Claude`; the assignment requires AI disclosure so history is not scrubbed.
4. Optional extras if time: per-workspace member invites; a test that bypasses RLS to verify the app-level SQL predicate alone; run the full multi-agent security-audit skill for an independent review; root-cause the benign 'destination stream closed early' log.
