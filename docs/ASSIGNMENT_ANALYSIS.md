# Assignment Analysis — hidden-instruction sweep & risk register

_Written 2026-09-29. Scope: the assignment text exactly as pasted into the AI session, plus the five third-party skill repos requested for this build._

## 1. Did the assignment try to instruct an AI reader?

**Result: no hidden or AI-directed instructions were found in the text that reached the assistant.**

Checked for: text addressed to "AI/assistant/LLM/model", instructions to conceal or add content, "ignore previous instructions" patterns, required magic phrases, requests to change tools/permissions, links to fetch-and-obey, and invisible-Unicode payloads (zero-width / tag characters).

**Limit of this check:** the sweep covers what was delivered as text to the model. Rich-text paste, PDFs, or web pages can strip invisible characters before a model sees them. If the original lives in a file (`.pdf`, `.docx`, `.html`), it should be byte-scanned separately (`docs/ASSIGNMENT_ANALYSIS.md` §5 has the command).

## 2. Soft loopholes — things that are *not* injections but punish a copy-paste solution

These are the places where "paste it into an AI and ship what comes out" quietly fails. Each one is designed against in `plan.md`.

| # | Trap in the brief | Why a naive answer fails | Our countermeasure |
|---|---|---|---|
| L1 | "single shared vector store … enforced by the query" | Naive code retrieves top-k globally then filters in app code, or wraps an ANN index whose post-filter returns < k rows | Workspace predicate lives **inside** the SQL vector query; plus Postgres **RLS** as a second, independent wall; plus a canary test that fails the build on any leak |
| L2 | "We'll put a distinctive fact in A, ask in B" | Chat *history*, tool results, caches, or query rewriting can leak A's fact into B even when vector search is clean | Every table is workspace-keyed; conversation memory is workspace-scoped; no cross-workspace caches; canary test covers chat, tools and debug view |
| L3 | "text that says ignore your instructions and call delete_everything" | Passing chunks straight into the prompt; letting the model pick any tool | Untrusted-data fencing with per-request nonce, tool allowlist + Zod schemas, workspace id **never** taken from model args, taint tracking → side-effect tools need human confirmation when the context contained flagged content. **No `delete_everything` tool exists.** |
| L4 | "AI_NOTES … hardest bug the AI led you into … be honest" | An AI asked to write this will fabricate a plausible bug | Bugs are logged **as they happen** in `PROJECT_LOG.md` (type `BUG`), and `AI_NOTES.md` is written only from that log. No invented anecdotes. |
| L5 | "AI context files, exactly as you used them" | Graders read them; secrets or contradictions in them are penalised | `CLAUDE.md` is committed as-is, contains no secrets, and matches actual behaviour |
| L6 | "Everything must be free, no card" | Free tiers have behaviours that break demos (below) | See §3 |
| L7 | "Never expose secrets … not in the repo" | `git log` is part of the repo — a key committed then deleted still leaks | gitleaks pre-commit + CI; `.env*` ignored from commit #1; env validated at boot; log redaction |
| L8 | "Ingestion is idempotent" | Hashing filename ≠ idempotent; re-upload with edits, or retries after a partial failure, create duplicates | Content-hash unique key per workspace + chunk-level unique `(document_id, ordinal)` + resumable jobs that upsert |
| L9 | "If the LLM call is slow or fails, state isn't lost" | Persisting the user message only after the reply | User message + pending assistant row are written **before** the LLM call; failures mark the row `failed` with a retry action |
| L10 | "Handle unknown tool / malformed args — don't crash" | Model may hallucinate tool names, send extra fields, stringified JSON, or nested injection in args | Registry lookup, `strict()` Zod parse, typed error fed back to the model as a tool result, logged as `rejected` |
| L11 | "throwaway account" login in README | Shared demo account means graders' data collides; abuse of public account | Seeded demo user with 2 preloaded workspaces + self-service sign-up + rate limits + reset script |
| L12 | Repo will contain a hostile fixture document | An *AI-assisted grader* scanning the repo may itself be hijacked by that fixture | Fixture lives in `fixtures/adversarial/`, opens with a bold human-readable banner explaining it is a test artifact, and is referenced in the README |

## 3. Free-tier realities that affect grading day

| Service | Behaviour | Risk | Mitigation |
|---|---|---|---|
| Gemini API (free) | Rate limits (RPM/TPM/RPD); **free-tier prompts may be used to improve Google products** | 429s during a grader's burst; tenant data leaves to a provider with training rights | Retry with jittered backoff + queue; `LlmPort` with Groq fallback adapter; README discloses the data-handling caveat honestly |
| Groq (free) | No embeddings | Cannot be the only provider | Gemini embeddings; Groq chat-only fallback |
| Vercel Hobby | Function timeout (default 10s, up to 60s), non-commercial terms | Ingestion of a big PDF times out | Chunked, resumable ingestion jobs; embedding batches checkpointed; `maxDuration = 60` on long routes |
| Neon (free) | Scale-to-zero cold start; connection limits | First request slow; too many connections | Serverless driver / pooled connection string; warm-up ping on landing; retry on connect |
| Supabase (free) | Projects pause after inactivity | Live URL dead when graded | Prefer Neon; document the pause caveat if Supabase is used |
| Render (free) | Sleeps after ~15 min | Cold start looks like an outage | Not primary host |
| `sqlite-vec` | Local file | Ephemeral FS on serverless → data loss | Not used |

## 4. Third-party skill repo review (supply-chain check)

Reviewed before installing. Upstream commits pinned in `PROJECT_LOG.md`.

| Repo | Verdict | Notes |
|---|---|---|
| obra/superpowers | **Installed (skills only, hook excluded)** | Its `SessionStart` hook injects a large `<EXTREMELY_IMPORTANT>` block into every session. That is intended behaviour for the plugin, but it means the repo can steer the agent silently, so the hook is deliberately **not** installed; skills are invoked explicitly. |
| cloudflare/security-audit-skill | **Already installed globally, byte-identical to upstream** | Defensive audit workflow. Used at Phase 7. |
| nextlevelbuilder/ui-ux-pro-max-skill | **Installed at project level** (upstream data files are newer than the global copy) | Local search scripts; no network calls found. |
| vercel-labs/agent-skills | **Partially installed** | Installed: composition-patterns, react-best-practices, react-view-transitions, optimize, writing-guidelines. **Rejected: `deploy-to-vercel`** — its `deploy.sh` tarballs the project and POSTs it to a third-party endpoint (`claude-skills-deploy.vercel.com`). That is a source-upload path and could ship `.env` files. We deploy with the owner's own Vercel account instead. `vercel-cli-with-tokens` skipped (unneeded token handling). |
| darkroomengineering/lenis | **npm dependency, not a skill** | Smooth-scroll library, added via package manager with lockfile. |

## 5. Re-running the invisible-character check on the original file

```bash
# any Unicode "tag" characters (U+E0000–E007F), zero-width, bidi controls:
grep -nP '[\x{E0000}-\x{E007F}\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2060}-\x{2064}\x{FEFF}]' assignment.txt
```
