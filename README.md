# Lattice — a multi-workspace document assistant

Ask questions about your documents and get **grounded answers with citations** — or an honest *"I don't know"*. Each user has several **workspaces**; all workspaces share **one vector store**, with isolation enforced *inside the query* and again by the database. The assistant can also **act** (save tasks, list tasks, send a summary to Slack/Discord) through validated tools, and it is built to stay safe when a document tries to give it orders.

> **Status:** feature-complete and tested locally (245 unit/integration tests, 27 browser tests, a 17-question live evaluation on real providers). **Live:** https://sbprag.vercel.app — sign in with the one-click demo account (see [`TESTING.md`](TESTING.md)).

- 📖 **Try it:** [`TESTING.md`](TESTING.md) — throwaway login, two preloaded workspaces, scripted isolation / "I don't know" / injection / tool checks.
- 🔐 **Security:** [`docs/SECURITY.md`](docs/SECURITY.md) (threat model) · [`docs/SECURITY_AUDIT.md`](docs/SECURITY_AUDIT.md) (findings + limits).
- 🧪 **Evaluation:** [`docs/EVALS.md`](docs/EVALS.md) · **Bug log:** [`docs/BUG_LOG.md`](docs/BUG_LOG.md) · **Build log:** [`PROJECT_LOG.md`](PROJECT_LOG.md) · **Plan:** [`plan.md`](plan.md).

## What it does — against the brief

| Requirement | How it is met | Where to look |
|---|---|---|
| Sign-in | Better Auth: scrypt passwords, server-side sessions, httpOnly `SameSite=Lax` cookie | `src/infra/auth.ts` |
| Multiple workspaces + switcher | Owner/admin/member/viewer roles, header switcher, `Ctrl/⌘ K` palette, per-workspace colour band | `src/ui/shell/` |
| **One shared vector store, strict isolation in the query** | `chunks` table shared by all workspaces; workspace predicate in the same SQL as the search; RLS + type-level scope + canary tests | `src/infra/db/repositories.ts`, `db/migrations/0002_security.sql` |
| Ingestion: chunk → embed → tag → idempotent | Heading-aware deterministic chunker, batched embeddings, `(workspace, content hash)` idempotency, resumable checkpointed jobs | `src/core/application/{chunker,ingest}.ts` |
| Grounded chat + citations + honest IDK | Relevance gate, server-verified citations, `NOT_IN_DOCUMENTS` protocol, uncited answers replaced by a refusal | `src/core/application/ask.ts` |
| ≥ 2 tools, validated, one real side effect | `save_task` (writes a row), `list_tasks`, `send_summary` (webhook), `search_documents`; strict Zod schemas, idempotency, timeouts, audit log | `src/core/application/tools/` |
| Prompt-injection resistance | Fenced context, allow-listed tools, identity from session, side effects **held for human approval** when hostile text was in context | `docs/SECURITY.md` |
| LLM failure / slow calls | Timeouts, retries with jitter, ordered failover (Gemini → Gemini → Groq) with a circuit breaker, durable turns + Retry | `src/infra/http.ts`, `src/infra/llm/fallback.ts` |
| Never expose secrets | Env-only secrets, validated at startup, AES-256-GCM for webhooks, log redaction, gitleaks in CI | `src/infra/{env,crypto,logging}` |
| Dashboard: documents, chat history, tool-call log | Documents · Chat (history sidebar) · Tool log · Tasks · Retrieval · Insights · Settings | `src/app/w/[id]/` |
| **Stretch:** retrieval-debug view | Every candidate with vector/keyword rank, fused score, isolation proof | Retrieval page / "Inspect retrieval" |
| **Stretch:** hybrid search | Vector + full-text fused with RRF in **one** statement, workspace predicate in both branches | `chunkStore.hybridSearch` |
| **Stretch:** streaming | SSE token streaming with the protocol line stripped mid-stream | `src/app/api/_lib/sse.ts` |
| **Stretch:** multi-step tool use | Bounded loop (max 4 steps); reads and actions distinguished | `ask.ts` |
| **Stretch:** opt-in cross-workspace sharing | Per document, read-only, one-way, non-transitive, revocable | `shareRepo`, `tests/integration/sharing.test.ts` |
| **Stretch:** observability | Per-question latency, retrieval, token and failover events; Insights page; request ids on every response | `src/app/w/[id]/insights` |
| Deliverables | README, `.env.example`, `TESTING.md`, AI context files (`CLAUDE.md`, `plan.md`, `PROJECT_LOG.md`, `.claude/skills/`) | this repo |

## Architecture

```
 Browser ──HTTPS──▶ Next.js 16 (App Router)                       Free tiers only
   │                 ├─ proxy.ts        CSP nonce, optimistic redirect
   │                 ├─ app/**          pages (server components) + 18 API routes
   │                 │     └─ workspaceRoute(): session → membership → TenantScope   ◀── the ONLY way in
   │                 ├─ core/           pure domain: chunker, grounding, injection fence,
   │                 │                  ask orchestrator, tool executor   (imports nothing from infra/ui)
   │                 └─ infra/          adapters: Postgres, Gemini, Groq, webhooks, parsers
   │                                              │
   │                       withTenant(scope) ─────┤  SET LOCAL ROLE lattice_app (RLS applies)
   │                                              ▼  app.user_id / app.workspace_id
   │                              Postgres 17 + pgvector  ── ONE shared `chunks` table
   └────────── SSE stream ◀── Gemini (embeddings + chat) → Groq (chat failover)
```

Hexagonal by rule, not by hope: `dependency-cruiser` fails the build if `src/core` imports anything from `infra`, `app`, `ui`, or Node/DB/framework packages (and that rule itself was tested with a planted violation).

## Run it locally

Requirements: **Node ≥ 22**, **Docker** (for Postgres + pgvector).

```bash
npm install
cp .env.example .env         # then fill in the values below
npm run db:up                # Postgres 17 + pgvector on 127.0.0.1:54329
npm run db:migrate
npm run seed                 # demo account + Acme Corp, Beta Labs, Security Lab (real ingestion pipeline)
npm run dev                  # http://localhost:3000
```

No API keys? Set `LLM_PROVIDER=fake` and `EMBED_PROVIDER=fake` for a deterministic offline mode (extractive answers, lexical embeddings) — great for exploring the UI, refused in production.

### Environment variables

Copy [`.env.example`](.env.example); it contains only placeholders. `.env` is git-ignored. Configuration is validated at startup and errors name the variable, never its value.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres 17 + pgvector. Local default matches `docker-compose.yml`. Production: Neon **pooled** connection string |
| `APP_URL` | yes | The exact origin users visit (e.g. `https://lattice.vercel.app`). Used for the CSRF origin check and auth trusted origins — a mismatch makes every mutation fail |
| `BETTER_AUTH_SECRET` | yes | ≥ 32 random chars |
| `ENCRYPTION_KEY` | yes | base64 of 32 random bytes (AES-256-GCM for webhook URLs) |
| `GEMINI_API_KEY` | if using Gemini | Free key from Google AI Studio |
| `GROQ_API_KEY` | optional | Chat failover (Groq has no embeddings) |
| `LLM_PROVIDER` / `EMBED_PROVIDER` | no | `gemini` \| `groq` \| `fake` (embeddings: `gemini` \| `fake`) |
| `GEMINI_CHAT_MODEL`, `GEMINI_CHAT_FALLBACK_MODELS`, `GEMINI_EMBED_MODEL`, `GROQ_MODEL` | no | Defaults: `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-embedding-001`, `openai/gpt-oss-120b`. Free-tier model availability changes; these are the ones that worked when tested |
| `LATTICE_ALLOW_FAKE_PROVIDERS` | no | Must be `1` to run fake providers with `NODE_ENV=production` |
| `LOG_LEVEL` | no | `debug` \| `info` \| `warn` \| `error` |

### Scripts

| Command | What it does |
|---|---|
| `npm run verify` | typecheck + lint + architecture rules + 245 unit/integration tests |
| `npm run e2e` | production build + 27 Playwright browser tests (throwaway DB, offline providers) |
| `npm run seed -- --reset` | rebuild the demo account and preloaded workspaces |
| `npm run eval:live` | the 17-question live evaluation (real providers) |
| `npm run smoke:live` | provider connectivity check |
| `npm run scan:secrets` | gitleaks over the full history (Docker) |

## Deploy (Vercel Hobby + Neon free)

How the live site was deployed. Verified at deploy time: all six migrations (including the `lattice_app` role) applied on Neon, the demo data seeded, and the live site signs in and answers. **Not independently verified on the live host:** response headers through Vercel's CDN, `Secure` cookie flags, and the rate limiter behind Vercel's proxy.

1. **Neon:** create/choose a project; copy the **direct** connection string (for migrations) and the **pooled** one (for the app).
2. **Migrate + seed against Neon** from your machine, using the *direct* URL — migrations take a session-level advisory lock that a transaction pooler does not preserve:
   `DATABASE_URL="<direct url>" npm run db:migrate` then `DATABASE_URL="<direct url>" npm run seed -- --reset` (ingestion embeds the demo documents, so your local `.env` must hold the provider keys; a `DATABASE_URL` set in your shell takes precedence over the `.env` one).
   (`0002_security.sql` creates the `lattice_app` role and runs `GRANT lattice_app TO CURRENT_USER`; this worked with Neon's default `neondb_owner` role on Postgres 18 with pgvector 0.8.6.)
3. **Vercel:** import the GitHub repo; set the variables from the table above in the project settings (`DATABASE_URL` = the **pooled** URL, `APP_URL` = the production URL). Never commit them.
4. **Smoke-test the live URL** with the checks in [`TESTING.md`](TESTING.md) (isolation, "I don't know", hostile document). Check response headers (CSP nonce, HSTS) and that the cookie is `Secure`.
5. Verify the rate limiter behaves behind Vercel's proxy (see the `X-Forwarded-For` note in `docs/SECURITY_AUDIT.md`).
6. **Rotate** any API key that was ever pasted into a chat transcript.

Free-tier notes: Vercel Hobby functions have a 60 s limit and a 4.5 MB request-body cap (upload limits are sized for it; ingestion is checkpointed and resumes if it runs out of time). Gemini free tier is rate-limited per model; the failover chain absorbs most of it.

## Repository tour

```
src/core/     pure domain — chunker, grounding, injection fence, ask orchestrator, tool executor, ports
src/infra/    adapters — db (Drizzle, RLS, migrations), auth, Gemini/Groq, webhooks, parsers, crypto, logging
src/app/      Next.js routes: pages, 18 API routes, proxy (CSP)
src/ui/       components: shell, chat, documents, activity, tasks, inspector, insights, settings, marketing
db/migrations hand-written SQL (extensions, schema, RLS/roles, …) with checksums
tests/        unit · integration (real Postgres) · e2e (Playwright) · helpers
fixtures/     demo documents + a clearly-labelled adversarial document
scripts/      migrate, seed, live eval, smoke, log helper
docs/         SECURITY, SECURITY_AUDIT, EVALS, ASSIGNMENT_ANALYSIS
```
