# Security model

How Lattice keeps workspaces apart and keeps a hostile document from steering the assistant — and where those guarantees stop. For the review that tested these claims, and its honest limits, see [`SECURITY_AUDIT.md`](SECURITY_AUDIT.md).

## What we protect

| Asset | Why it matters |
|---|---|
| Document text and its embeddings | Confidential to one workspace; the whole product is that it never appears in another |
| Chat history and tool-call log | Per user, per workspace |
| Webhook URLs (Slack/Discord) | A webhook URL *is* a credential |
| Provider API keys, auth secret, encryption key | Total compromise if leaked |
| The side-effecting tools (`save_task`, `send_summary`) | Must only act on the user's behalf, never on a document's |

## Who we defend against

1. **Another user** trying to read or affect a workspace they are not in (including guessing ids).
2. **A member of workspace A** trying to see workspace B's documents through the assistant.
3. **A document author** — anyone whose text ends up in a workspace — trying to instruct the model (prompt injection), exfiltrate data, or trigger tools.
4. **A network attacker / malicious site** (CSRF, XSS, open redirect).
5. **Our own bugs.** Several layers below exist specifically because any single layer will eventually have a bug.

*Not in scope:* a compromised server process or database credentials, a malicious operator, and provider-side data handling (see limits).

## Workspace isolation — four independent layers

One shared vector table (`chunks`), as the assignment requires. Separation is not a convention; it is enforced four ways:

1. **Type layer.** Data access needs a `TenantScope`, a branded type that can only be built by `resolveTenantScope`, which checks membership. Forgetting to scope is a compile error; the model never supplies a workspace id.
2. **Query layer.** The workspace predicate is inside the *same SQL statement* as the vector and keyword search (both branches of the hybrid query) — filtering happens in the query, not after it. Search is exact within a workspace up to 50,000 visible chunks, because approximate (HNSW) filtered search can under-return for small tenants.
3. **Database layer.** Postgres row-level security on every workspace-scoped table, evaluated under a role without `BYPASSRLS`, driven by `app.user_id` / `app.workspace_id` settings that fail *closed* (unset ⇒ nothing visible). A composite foreign key (`chunks(document_id, workspace_id)`) stops a chunk being attached to another workspace's document.
4. **Evidence layer.** Canary tests (a fact that exists only in workspace A must never reach B's retrieval or B's model prompt), a retrieval inspector that shows the workspace of every candidate chunk, and a server-side invariant that refuses to answer if a foreign, unshared chunk ever appears.

Cross-workspace sharing is **opt-in, per document, read-only, one-way and non-transitive**; it requires admin rights in the source and membership of the target, and revoking is immediate. Without a share row, nothing crosses.

## Prompt injection — assume the model can be fooled

Retrieved text is **data, never instructions**. The defences do not rely on the model behaving:

- Hidden Unicode (tag characters, zero-width, bidi) is stripped at ingestion; an advisory scanner flags instruction-like text (and the document is labelled, not deleted).
- Context is wrapped in **nonce-fenced blocks**; the fence markers inside document text are neutralised; the question comes after an unforgeable marker.
- Tools are an **allow-list with strict schemas**; unknown tools, malformed JSON and schema violations are rejected *and recorded*. Identity and workspace come from the session, never from tool arguments.
- If flagged text was in the model's context, any **side-effecting tool is held for explicit human confirmation** — and that confirmation endpoint is authenticated, same-origin, member-only, and atomic (exactly-once even if clicked repeatedly).
- Answers are **verified server-side**: the model must state `ANSWERED` or `NOT_IN_DOCUMENTS`; citations are validated against what was actually retrieved; an uncited claim is replaced by an honest refusal.
- The test model for the injection suite is deliberately **gullible** — it obeys any instruction it can see — to prove the application's defences hold even when the model's do not.

The scanner is a *hint*. The structural controls above are the boundary.

## Web and session security

- Auth via Better Auth (scrypt passwords, server-side sessions); cookie is `httpOnly`, `SameSite=Lax`, `Secure` + `__Secure-` prefix in production; 7-day expiry.
- **Every** mutating route checks same-origin (`Origin` / `Sec-Fetch-Site`) — enforced by a structural test so new routes cannot forget.
- Nonce-based **CSP** with `strict-dynamic` (no `unsafe-inline` for scripts or styles), `frame-ancestors 'none'`, `object-src 'none'`, `form-action 'self'`, HSTS and the other standard headers.
- Markdown answers are rendered by a small safe renderer: **no HTML, no links, no images**.
- Uploads: type by magic bytes (not extension), size caps under the platform limit, ZIP-bomb defence before any decompression.
- Errors use one uniform envelope with a request id; internals go to logs only.

## Secrets

- Provider keys and secrets live only in environment variables (`.env` is git-ignored; `.env.example` holds placeholders). CI has **no secrets**.
- Env is validated at startup (fail fast); fake providers are refused in production.
- Webhook URLs are encrypted at rest (AES-256-GCM) and **bound to their workspace** (moving a ciphertext to another workspace fails to decrypt); the API only ever returns a masked hint.
- Logs redact sensitive fields; DB errors are re-thrown without Drizzle's bound-parameter dump; upstream provider error bodies are never copied into our errors.
- Secret scanning: gitleaks in CI over full history (`.gitleaks.toml` allow-lists four inert test fixtures by exact value).

## Resilience as a security property

Providers fail and are slow. Every outbound call has a per-attempt timeout and an overall deadline; only transient errors are retried (with jittered backoff, `Retry-After` honoured); bad keys are never retried in place; the model chain fails over (Gemini → Gemini → Groq) only **before** any output is emitted (never splicing two models' text), with a circuit breaker so a rate-limited model is not re-probed on every request. A question is persisted before any provider call, so a failure never loses the user's input and is retryable on the same turn.

## Known limits (summary)

The full, evidence-linked list is in [`SECURITY_AUDIT.md`](SECURITY_AUDIT.md#limits-and-accepted-risks-not-fixed-deliberate-or-unproven). The ones a reader should not miss:

- RLS protects against **application bugs**, not a compromised application process (which holds the DB credentials).
- No email verification, password reset, or per-account lockout (per-IP throttling only).
- Document text is sent to the LLM providers; free-tier terms may differ from paid — **do not put confidential data in the public demo.**
- The review was done by the same AI that wrote the code, without independent verification.

## Reporting

This is an assignment project; there is no production data. If you find an issue, open a GitHub issue on the repository.
