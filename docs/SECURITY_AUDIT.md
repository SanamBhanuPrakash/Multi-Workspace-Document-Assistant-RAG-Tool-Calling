# Security review — findings

**What this is:** a focused, source-first review of Lattice's trust boundaries, done with the method of the Cloudflare `security-audit` skill (require a boundary + a concrete result; prove with bounded local tests; separate *confirmed* from *unverified*; smallest effective fix).

**What this is not — read this first:**

- It was performed by **the same AI that wrote the code**. That is an author-bias risk the skill's full workflow avoids with independent verifier agents. I ran the skill in *guidance mode* (a single-agent review), **not** its six-phase multi-agent audit. Treat it as a strong self-review, not an independent penetration test.
- It covers source and local tests only. **Nothing deployed was probed** (there is no deployment yet).
- Date: 2026-09-30. Commit range: from `234912e` to the commit that adds this file.

Method used on every candidate: *lower-trust principal → accepted input → intended control → crossed boundary → affected resource → observed result.* A missing best practice with no reachable boundary violation is listed under "Limits", not "Findings".

## Confirmed findings (all fixed, each with a test that failed first)

| # | Sev. | Boundary | Finding | Fix | Regression test |
|---|---|---|---|---|---|
| F1 | Low–Medium (integrity) | Authenticated member → external webhook | **Double execution of a held action.** `resolveConfirmation` read `status = awaiting_confirmation` and then unconditionally updated it. 8 simultaneous "Approve" requests on one held `send_summary` sent **7** webhooks. Needs an authenticated member with write role (double-click or two tabs); no cross-tenant effect. | `ToolCallRepo.claimHeld`: atomic compare-and-set (`UPDATE … WHERE status = 'awaiting_confirmation' RETURNING`). Exactly one caller wins; losers replay the current state. Applied to approve and decline. | `tests/integration/tools.test.ts` — concurrent approvals run exactly once; approve-vs-decline race can never leave a task under `declined` |
| F2 | Low (availability) | Any member → upload endpoint | **Upload limit larger than the platform's request cap.** Per-file limit was 5 MB but Vercel rejects request bodies > 4.5 MB *before our code*, with a non-JSON error, so our validation and error envelope never ran for large files. | 4 MiB per file, 4.5 MB per request, enforced up front with the standard error envelope; UI copy updated. | `tests/e2e/documents-and-tools.spec.ts` — 4.6 MB upload → 413 `payload_too_large` |
| F3 | Low (availability / quota) | App → LLM provider | **401/403 were retried in place** despite the code comment saying they should not be (the thrown error was caught by the function's own retry `catch`). A bad or revoked key burned quota and added latency. | Private no-retry marker; the error keeps `kind: unavailable` so the failover chain can still fall back to another provider. | `tests/unit/http.test.ts` |
| F4 | Low (defence-in-depth) | Browser CSP | **Radix scroll-lock style was blocked by our own strict CSP** (its nonce comes from `__webpack_nonce__`, unset under Turbopack), so overlays silently did not lock scroll. The CSP was correct; the integration was not. | A per-request nonce'd inline script sets `__webpack_nonce__`. CSP stays strict — no `unsafe-inline` for styles. | `tests/e2e/security-and-a11y.spec.ts` — overlays open with zero CSP violations |

Other correctness/robustness defects found and fixed during the same period are in `PROJECT_LOG.md` (sign-up race, follow-up retrieval poisoning, chat state bugs, etc.); they had no security impact beyond availability of the affected feature.

## Boundaries reviewed with no finding

| Area | What I checked | Evidence |
|---|---|---|
| **Tenant isolation** | Workspace predicate inside the search SQL; Postgres RLS on every workspace-scoped table under a non-`BYPASSRLS` role; branded `TenantScope`; composite FK. | `rls.test.ts` (13), `ingest-and-retrieval.test.ts` canaries, `ask.test.ts` (asserts the model's prompt never contained the other workspace's text), `sharing.test.ts` (13), e2e isolation scenario, live eval 6/6 cross-workspace refusals |
| **AuthN on every API route** | Route inventory: all tenant routes use `workspaceRoute` (membership verified before the handler); all mutating verbs set `mutating: true` (same-origin check). Now enforced by a structural test so a new route cannot silently skip either. | `tests/unit/route-guards.test.ts` (mutation-verified: removing one `mutating: true` fails it) |
| **IDOR on object ids** | Conversations are filtered by workspace **and** user; tool calls, messages, documents by workspace under RLS; foreign/unknown ids give a plain 404 (no existence oracle). | `workspaces`/`ask`/`tools` tests; e2e "cannot open someone else's workspace by URL" |
| **CSRF** | httpOnly, `SameSite=Lax`, `__Secure-` cookie in production + `Origin`/`Sec-Fetch-Site` check on every mutation. | e2e cookie-flags and cross-origin tests |
| **SQL injection** | No `sql.raw` in `src/`; every `${}` inside a drizzle `sql` template is a bound parameter. | grep of the source; injection-style ids in `ingest-and-retrieval.test.ts` |
| **SSRF (webhooks)** | Exact `hooks.slack.com` / Discord URL shapes only, https, no userinfo/port/query, no redirects followed. | `tools.test.ts` validator table |
| **Stored XSS** | Safe markdown renderer (no HTML, links or images); document text rendered as text. | `markdown.test.tsx`, e2e stored-XSS test |
| **Upload parsing** | Magic-byte sniffing (not extension), ZIP central-directory bomb defence before decompression, size limits. | `parsers.test.ts` |
| **Secrets** | Webhook URLs AES-256-GCM encrypted, bound to `workspaceId:kind` via AAD (moving ciphertext to another workspace fails to decrypt); DB errors sanitised so Drizzle's `params:` dump never reaches logs; pino redaction; provider error bodies never copied into errors; **gitleaks over all history: no leaks** (4 inert test-fixture findings allow-listed by exact value; a planted real-looking secret is still caught). | `tools.test.ts`, `workspaces.test.ts`, `http.test.ts`, CI `secrets` job |
| **Prompt injection** | Structural defences (nonce-fenced context, tool allow-list, strict schemas, identity only from session, taint-gated side effects with human confirmation), tested against a deliberately *gullible* model. | `ask.test.ts` injection suite; e2e hostile-document test |
| **Open redirect** | `next` parameter restricted to same-site paths. | e2e |
| **Dependencies** | `npm audit`: 4 *moderate*, all through `drizzle-kit` → legacy `@esbuild-kit` → `esbuild <=0.24.2` (advisory: esbuild's **dev server** answers cross-origin requests). Nothing here starts an esbuild dev server; `drizzle-kit` is a devDependency and migrations are hand-written SQL run by our own script. `npm audit fix --force` would *downgrade* drizzle-kit to 0.18.1, so it was deliberately not applied. CI fails on `high`/`critical`. | `npm audit` output |

## Limits and accepted risks (not fixed; deliberate or unproven)

1. **Author bias / no independent review** (see top). The strongest available mitigation is more eyes: run the full multi-agent skill or have a human reviewer read `docs/SECURITY.md` and the route guards.
2. **RLS is defence-in-depth against application bugs, not against a compromised application process.** The app sets `app.user_id` / `app.workspace_id` from the verified session; a process that holds the database credentials could set any values. Real protection against that needs per-tenant database roles or a separate policy service — out of scope for this build.
3. **The app-level workspace predicate is not independently tested.** Mutation testing showed that breaking `visibleChunk` (making shared rows visible to everyone) is still caught by RLS, so *all 13 sharing tests still pass* — great for defence in depth, but it means only the *pair* is verified, not each layer alone. A test that bypasses RLS to assert the SQL predicate would close this.
4. **No email verification, password reset or per-account lockout.** Sign-in is throttled per IP (8/min) and sign-up per IP (10/h) using a Postgres counter. Credential stuffing spread across many IPs is not slowed per account. Trade-off for a free-tier build with no mail provider.
5. **Rate-limit IP comes from `X-Forwarded-For` / `X-Real-IP`.** Behind Vercel the platform sets these, so they are trustworthy there; behind any other proxy (or none) a client could spoof them and evade the per-IP auth throttle. Per-user limits (chat, upload) are unaffected. *Needs validation on the real deployment.*
6. **`style-src-attr 'unsafe-inline'`** is set (React SSR emits `style=""` attributes). Script execution — the thing that matters — is locked to nonces + `strict-dynamic`. This would matter only if an HTML-injection bug existed; none was found.
7. **The injection scanner is advisory** and its corpora are self-authored: it verifies the spec, not real-world recall. The structural defences carry the weight.
8. **Free-tier provider data terms.** Document text is sent to Gemini (embeddings + chat) and possibly Groq. Free-tier terms can differ from paid ones (for example on use of prompts to improve products) — check the current terms and **do not upload confidential documents to the public demo**.
9. **Public demo account.** `demo@lattice.demo` is a deliberately public throwaway; any reviewer can change or delete its data. `npm run seed -- --reset` restores it.
10. **A benign-looking server log** — Next.js `The destination stream closed early` — appears during page-closing browser tests. No single request reproduces it and no functional effect was found; treated as a client disconnect while a page streams, **not root-caused**.
11. **Not tested:** load / denial-of-service behaviour, the deployed environment (headers through the CDN, cookie `Secure` behaviour, `APP_URL` mismatch on preview URLs), long-running-abuse economics of the free LLM quota.
