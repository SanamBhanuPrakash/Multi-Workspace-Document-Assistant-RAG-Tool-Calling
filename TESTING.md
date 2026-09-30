# Testing Lattice

Two ways: **try it by hand in two minutes**, or **run the automated suites**. Everything below was verified against the code in this repository; the live-URL steps apply once the app is deployed (see the README).

## 1. Try it by hand

**Throwaway login** (public by design — it holds only fabricated documents):

| | |
|---|---|
| Email | `demo@lattice.demo` |
| Password | `Lattice-Demo-2026!` |

On the sign-in page, **"Enter demo account"** signs in with one click. Anyone can edit this account, so if it looks odd, `npm run seed -- --reset` restores it. Or create your own account on **Create an account** — a new user starts with one empty workspace.

**Preloaded workspaces** (switch with the workspace menu in the header, or `Ctrl/⌘ K`):

| Workspace | Documents | Distinctive facts |
|---|---|---|
| **Acme Corp** | Employee Handbook, Security Policy | vault access code `ZEBRA-4417`; launch codename `BLUEHERON-77`; 25 days annual leave; refund window 14 days; high-severity incidents reported within 72 h; meal allowance 45 |
| **Beta Labs** | Engineering Onboarding, Incident Runbook | sev-1 escalation phrase "**orange lantern**"; on-call rotation starts Monday; learning budget 1,500 |
| **Security Lab** | one deliberately hostile document (clearly labelled as a test artifact) | widgets cost 40 dollars for 100+ units — next to hidden instructions to call tools |

### A. The isolation test (the one that matters)

1. Open **Acme Corp** → Chat → ask **"What is the vault access code?"** → you get `ZEBRA-4417` with a citation chip. Click **Inspect retrieval**: the panel says *Isolation verified* and *0 from any other workspace*.
2. Switch to **Beta Labs** → ask **the same question** → *"Not in this workspace's documents."* No model call is made and no Acme text is ever in the prompt.
3. Still in Beta Labs, ask **"What is the escalation phrase used to confirm a sev-1?"** → *orange lantern*, cited. Then switch back to Acme and ask it — refused.
4. Documents page: each workspace lists only its own files. Upload the same file into both and you get two independent documents (same content ≠ shared).

### B. "I don't know" is a real answer

In Acme Corp ask: **"What is the capital of France?"**, **"Who is the CEO of Acme Corp?"**, **"What is the office wifi password?"**. Each is refused honestly — the first two kinds differ: France never passes the relevance gate; CEO/wifi retrieve related text but the model's `NOT_IN_DOCUMENTS` verdict is enforced server-side.

### C. Tool calling with a real side effect

1. In any workspace ask: **"Save a task: renew the vault code by Friday"**. A tool card appears (`save_task`, *Succeeded*).
2. **Tasks** page: the task is there, in *this* workspace only. **Tool log** page: the call, its validated arguments, status and latency. Switch workspaces: the task does not follow you.
3. Second tool: ask "list my open tasks". Third: **Settings → Integrations** lets an admin add a Slack/Discord webhook; without one, "send a summary to Slack" fails politely instead of pretending.
4. Idempotency is per assistant reply: **retrying the same reply** (or a duplicated tool call inside it) never creates a second task. (Asking again in a *new* message is a new request and does create a new task — that is intended.)

### D. Prompt injection

1. Open **Security Lab**. Ask **"What do widgets cost when ordering 100 units?"** → *40 dollars*. The document also contains instructions telling the model to call `delete_everything`, `save_task` and `send_summary`. **Nothing runs.**
2. **Tool log**: no `delete_everything` entry that executed and no planted task. If a real model ever *does* propose a side-effecting call while hostile text is in its context, it is **held for your explicit confirmation** and shown as awaiting approval — that path is covered by a test with a deliberately gullible model.
3. The document is flagged in **Documents** ("1 flagged"); it is still searchable as data.

### E. Opt-in sharing (stretch)

Documents → **Share** on a Acme document → choose Beta Labs. Ask Beta about it: it now answers with a citation and the inspector marks the source *shared in*. **Stop sharing** → gone immediately. It is per document, read-only, one-way and non-transitive.

### F. Dashboard and debugging views

**Documents** (status, sizes, flags, sharing), **Chat history** (sidebar; per workspace and per user), **Tool log**, **Tasks**, **Retrieval** (every candidate chunk with vector/keyword rank, fused score and the isolation proof), **Insights** (questions answered, retrieval hit rate, latency p50/p95, error rate, models that served requests with tokens in/out, tool-call outcomes).

### G. Resilience

Kill the network or provider key, then ask a question: your question is already saved, the reply is marked failed with a **Retry** button (same turn, no duplicate). Provider failover (Gemini → Gemini → Groq) is invisible to you except in Insights ("Models that served requests").

## 2. Run the automated tests

```bash
npm install
npm run db:up          # Postgres 17 + pgvector in Docker (127.0.0.1:54329)
npm run verify         # typecheck · lint · architecture rules · 245 unit + integration tests
npm run e2e            # production build + 27 browser tests (Playwright, real Chromium)
npm run scan:secrets   # gitleaks over the full git history (needs Docker)
```

`verify` and `e2e` need **no API keys**: they use deterministic offline providers and a throwaway database (`lattice_test`, `lattice_e2e`), recreated on every run. First browser run: `npx playwright install chromium`.

### What the suites prove

| Suite | Count | Highlights |
|---|---|---|
| RLS (`tests/integration/rls.test.ts`) | 14 | non-`BYPASSRLS` role; every workspace table has RLS + policy; unfiltered `SELECT *` and vector search see only own rows; forged scope sees nothing; unset context fails closed; composite FK |
| Ingestion / retrieval (`ingest-and-retrieval`) | 17 | idempotent re-upload; same content in two workspaces = two docs; resume after provider failure; canary queries across workspaces |
| RAG orchestrator (`ask.test.ts`) | 36 | citations verified server-side; honest refusal; fabricated citations removed; nonce fencing; durable turns and retry; CANARY through the full chat path; **injection suite with a fully gullible model** |
| Tools (`tools.test.ts`) | 49 | strict schemas; unknown/malformed/oversized calls rejected and logged; idempotency; taint gate; **concurrent approvals run exactly once**; webhook SSRF table; secrets encrypted and bound to their workspace |
| Sharing (`sharing.test.ts`) | 13 | default isolation; grant/revoke; per-document, one-way, non-transitive; role and membership gates; cascade on delete |
| Workspaces | 7 | first-visit race (25 users × 3 overlapping requests); DB errors never carry bound parameters |
| Unit | 109 | chunker, security scanner/fence/grounding/webhook, parsers (ZIP bomb), markdown renderer, **retry layer and LLM failover/circuit breaker**, route guards, repo hygiene (no hidden Unicode) |
| Browser e2e | 27 | isolation through the UI; upload/idempotency; tools; hostile document; stored-XSS; CSP + headers + per-request nonce; CSRF; cookie flags; open redirect; axe accessibility on landing, auth and every dashboard page; keyboard palette; mobile overflow; sharing dialog; oversize upload |

### Live evaluation (real providers, uses the free tiers)

```bash
# .env needs GEMINI_API_KEY (and optionally GROQ_API_KEY)
npm run seed -- --reset
npm run eval:live      # 17 questions incl. 6 cross-workspace; details in docs/EVALS.md
```

### Testing the deployed URL

Repeat sections A–D by hand. To smoke-test provider connectivity from your machine against the same keys: `npm run smoke:live`. The health probe `GET /api/health` returns `{"ok":true}` and reveals nothing about configuration.
