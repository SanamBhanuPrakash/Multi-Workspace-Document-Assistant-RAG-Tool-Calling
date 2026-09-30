# Bug log

The full, log-derived record of bugs found while building.

Everything below is derived from [`PROJECT_LOG.md`](PROJECT_LOG.md), which was appended to **while the work happened** (`scripts/log.sh`), including the mistakes. Nothing here is reconstructed from memory or invented for the write-up. Timestamps are IST.

## How AI was used

- **Author:** the code was written by **Claude** (Anthropic; Claude Code, model *Sonnet 5.5*) working in this repository under the direction of the project owner. Commits carry a `Co-Authored-By: Claude` trailer; history was deliberately not rewritten.
- **The owner supplied:** the assignment and standing instructions (quality bar, "log everything", "do not push", stop/resume protocol), the Gemini and Groq API keys (kept only in a git-ignored `.env`), and the GitHub/Neon targets. **Deployment has not happened** — Neon needs the owner's browser login and Vercel needs their account, neither of which the assistant can do.
- **Context files, committed as used:** [`CLAUDE.md`](CLAUDE.md) (project rules), [`plan.md`](plan.md) (the contract, with decisions), [`PROJECT_LOG.md`](PROJECT_LOG.md), and the vetted skills in `.claude/skills/`.
- **Third-party AI skills were treated as untrusted code and reviewed before use** (`docs/ASSIGNMENT_ANALYSIS.md`): the *superpowers* SessionStart hook was **not** installed (it injects instructions into every session); *deploy-to-vercel* was **rejected** (it tars the project and POSTs it to a third-party endpoint); the Neon CLI's `skills`/`mcp`/`deploy`/placeholder-bucket steps were skipped as unneeded. The Cloudflare `security-audit` skill was used (see caveat in `docs/SECURITY_AUDIT.md`).
- **Was the assignment text itself checked for hidden AI-directed instructions?** Yes, first, before any code: none found in the text as received (with the honest limit that invisible characters could not be ruled out from a pasted copy). The same concern shaped the code: hidden-Unicode stripping at ingestion, and a repo test that fails the build if any tracked file contains invisible/bidi characters.

## The hardest bug the AI led into: "the tests pass" that meant nothing (ANN retrieval)

This is the one where the AI's confident reasoning and green tests were both wrong, and the log shows the sequence:

1. **23:34 — a wrong all-clear.** I probed whether filtered vector search (pgvector's HNSW index applies workspace filters *after* the graph scan) could return too few rows for a small tenant next to large ones. It "could not be reproduced". I logged that, and a regression test named for the shortfall was passing — **for a different reason than its name claimed** (my probe used an explicit workspace predicate, which steers the planner to an exact scan). I renamed the test honestly, but the conclusion was still wrong.
2. **23:36 — the correction.** The full suite (not the single file) failed after another file added rows. With a few thousand foreign rows and a query with **no explicit predicate** (only RLS), the planner picks HNSW; it returns its 100 nearest rows (all foreign), RLS drops them, and the tenant gets **zero rows**. It fails *closed* (no leak) but wrong. Fix: `hnsw.iterative_scan` on every tenant transaction. My first regression fixture (3,000 *identical* vectors) didn't pass even with the fix, because HNSW degenerates on exact duplicates — so I changed the fixture, not the product, and verified the test fails without the fix.
3. **23:44 — the deeper problem.** My own hybrid query used `ROW_NUMBER() OVER` before `LIMIT`, so it did a full scan and **HNSW was never used at all**: the early canary and recall tests had passed *by query-shape accident*, not because search was correct. I restructured it, and then saw an intermittent empty result for outlier vectors even with iterative scan. **Decision:** search **exactly** within a workspace (btree on `workspace_id` + sort; `(dist) + 0` blocks HNSW) up to 50,000 visible chunks, ANN only above that.
4. **The log states the limit of that evidence:** forcing ANN mode still passed my final recall fixture 3/3, so **the tests do not prove exact search is necessary** — the decision rests on one observed flake plus reasoning about HNSW reachability. The next morning (11:10) the same behaviour resurfaced as a flaky assertion in `rls.test.ts` (it asserted ANN *recall*, not isolation); I corrected the assertion to the safety property only and logged that it loosens a count, not the isolation check.

**Why it was hard:** the failure mode is silent (under-returning, never leaking), and the AI's own tests gave false comfort. **What it changed in the process:** every guardrail now needs a *failing* run before it is trusted (planted violation, mutation, or removing the fix).

## Other real bugs, in the order they were logged

| When | What went wrong | How it was caught | Fix |
|---|---|---|---|
| 09-29 23:21 | Drizzle wraps DB errors as `Failed query: … params: <every bound value>`; logging `err.message` would leak document text and secrets | An RLS test failed because my regex didn't match the wrapper | Unwrap the driver error, drop params (`DbError`/`safeError`); tested |
| 23:23 | The dependency-cruiser "core is pure" rule silently did nothing for npm imports (`exclude` removed `node_modules` from the graph) | Only because I planted a `pg` import in `core` as a **negative test** | Fixed; added a Node-builtins rule. Lesson: every guardrail gets a planted-violation test |
| 23:25 | Chunker rejoined one paragraph's sentences with blank lines (fake paragraph breaks, overlap didn't match) | Overlap-suffix unit test | `newPara` flag; join within a paragraph |
| 23:36 | **Process error:** committed after tests with `;` instead of `&&`, so a commit went in with 1 failing test + 2 type errors | Noticed immediately after | Fixed next commit; gates are chained with `&&` since |
| 00:26 | A tool timeout raced the tool's own abort listener and was reported as `internal_error` | "Slow tool" test | The timer is authoritative (`timedOut` flag) |
| 00:29 | **Trojan-Source class:** my file-writing tool converted `\u`-escape *text* into real invisible characters (zero-width, bidi) inside a regex — unauditable, though tests passed | Writing a guard test flagged its own source file | `scripts/escape-hidden.py`; `repo-hygiene.test.ts` fails the build on any hidden/bidi char |
| 00:33 | Gemini chat returned 404: `gemini-2.5-flash` is closed to new users — **my model knowledge was stale** | Live probe + list-models | Ordered failover chain across the models that actually work |
| 00:39 | User and assistant rows inserted in one transaction share `now()`, so history came back `[assistant, user]` non-deterministically | Durability test | `messages.seq` identity column |
| 00:39 | Two of my *tests* were wrong (a canary asserted the whole prompt lacks the secret, but the user's own question legitimately contains it; a scripted-model regex ignored JSON escaping) | Test failures | Tests corrected |
| 01:07 | **Live eval:** Groq writes citations as fullwidth `【1】`; my validator called correct answers "uncited" and refused them | Only real providers exposed it — scripted models can't | `normalizeCitations()` + tests |
| 01:07 | **Live eval:** after a retrieval miss the model called the read-only `search_documents`, and my logic treated *any* successful tool as a reason to skip grounding checks | Live eval | `ToolDefinition.citable`; only action tools may justify an uncited reply |
| 01:19 | CSP: the toast library injected a `<style>` without a nonce | Browser console in a real-browser run | Replaced it with an in-house toast rather than weaken CSP |
| 01:19 | Landing hero **invisible** under `prefers-reduced-motion` (SSR rendered `opacity:0`; the client swapped components; production React doesn't repair attribute mismatches) | Only by screenshotting with reduced-motion emulation | Progressive enhancement: visible by default, JS opts elements *in* |
| 09-30 10:14 | **Fresh sign-up crashed the server.** My first hypothesis (concurrent `/app` renders double-inserting the first workspace) was logged as an **open question, explicitly unproven** — a direct 12-way burst test passed *without* the lock, so my regression test proved nothing | Removed *only* the lock and re-ran the browser flow: 3/3 failed with `duplicate key … workspaces_owner_slug_uq` | The hypothesis was right; the lock stays; new test (25 users × 3 overlapping calls) fails without it |
| 10:18 | Follow-up questions always refused under the offline model: it answered the "rewrite this as a query" request with its own `STATUS: NOT_IN_DOCUMENTS` line, which became the search query. A real model could do the same | Browser suite | Reject protocol lines as rewrites; my *first* regression test was vacuous (a retrieval miss makes no answer call, so it was asserting turn 1) — tightened until it failed without the fix |
| 10:31 | **Every chat answer after the first hung on "Searching…"** (server fine at 240 ms, browser received every event). An updater read a ref that the next line mutated; React ran it lazily when updates were queued | Ruled out two wrong hypotheses first (a refresh race — falsified by a 2 s wait; server slowness), then tracing the client | Capture the id before mutating |
| 10:34 | **That fix masked a second bug** (I logged a correction): the first answer's `router.refresh()` flipped the component's `key`, remounting the chat from a stale server snapshot mid-stream | A DOM-marker experiment (wait 3 s: remount happens during the wait; wait 0: remount lands mid-turn-2) | `key` no longer includes the conversation; the chat adopts its own new conversation |
| 11:04 | The provider retry/failover layer had **zero automated tests** — it had only ever run live. Writing them exposed that **401/403 were retried** despite a comment saying they shouldn't be | Writing the missing tests | No-retry marker that still allows failover |
| 11:15 | **Security review:** approving a held action was check-then-act; 8 simultaneous approvals sent **7** webhooks | A concurrency test, written to fail first | Atomic compare-and-set (`claimHeld`) |

## Corrections the AI had to make to its own claims

- The ANN "not reproducible" note (above) — wrong.
- Logging sign-up "root cause" only as a hypothesis, then finding the regression test didn't discriminate — kept open until proven.
- The first `condense` regression test and the first ANN regression fixture were vacuous or unrealistic.
- A "fix" (stale updater) that *masked* the real remount bug: it was logged as a correction, not silently amended.
- One benign server log (`The destination stream closed early`) is **still not root-caused**; `docs/SECURITY_AUDIT.md` says so.

## What this says about trusting AI-written code

- **Green tests were not evidence until they had been seen red.** The ANN, sign-up-race, condense and follow-up fixes each had a first test that passed for the wrong reason. The working rule became: remove the fix, watch the test fail with the production error, restore, watch it pass. Regression tests here were verified that way, and mutation checks were run on the sharing and route-guard suites.
- **Real providers found what scripted ones could not** (fullwidth citations, the read-tool bypass, free-tier rate-limit behaviour, stale model knowledge). Hence the live eval (`docs/EVALS.md`), whose limits are stated there.
- **The browser found what unit tests could not** (React update ordering, remount races, CSP, reduced-motion). The e2e suite exists because of that.
- **Independence is missing.** The same AI wrote the code, the tests and the security review. `docs/SECURITY_AUDIT.md` says so; a human reading the route guards, `src/infra/db/repositories.ts` and `docs/SECURITY.md` is the highest-value next step.

## Not done (so nothing here overclaims)

Deployment (needs the owner's Neon and Vercel accounts), a live-URL smoke test, an independent multi-agent security audit, load testing, and email verification / password reset / per-account lockout.
