# Architecture review — Splitt MCP server, 2026-09-21

Reviewed at `origin/main` `4c73e65`. Every file under `src/` was read in full (1,981 hand-written lines plus 27,974 generated), and the conclusions below were checked against the live production server and the backend's own source rather than against this repo's documentation.

Companion tickets: [SPLIT-1499](https://splitt.atlassian.net/browse/SPLIT-1499) cleanup, [SPLIT-1500](https://splitt.atlassian.net/browse/SPLIT-1500) contract drift, [SPLIT-1501](https://splitt.atlassian.net/browse/SPLIT-1501) tool descriptions, [SPLIT-1502](https://splitt.atlassian.net/browse/SPLIT-1502) environment and merge gate.

---

## 1. What this service is

A stateless Model Context Protocol server on Next.js 15, deployed as a single Vercel function at `POST /api/mcp`. It exposes 18 tools and 1 resource to LLM clients and translates each call into one or more REST calls against the SplitMyGear backend, forwarding the caller's own bearer token.

The defining architectural decision is recorded in `docs/adr/0001-mcp-is-a-backend-rest-client.md` and it still holds: **the MCP owns no data and no credentials of its own.** There is no database client, no Stripe key, no LLM provider key. The lockfile contains zero `@supabase` or `stripe` entries. Everything the server can do, it does by asking the backend on the caller's behalf, which makes the backend the single authority for authorization, pricing and payment. That is the right shape for this service and nothing in this review argues against it.

| Component | Lines | Responsibility |
|---|---|---|
| `src/app/api/mcp/route.ts` | 503 | Transport, auth and rate-limit orchestration, 18 tool registrations, 1 resource |
| `src/middleware/auth.ts` | 73 | Deny-by-default; operator key or bearer JWT |
| `src/lib/jwt.ts` | 190 | Bearer verification, local HS256 or backend round-trip |
| `src/middleware/rate-limit.ts` | 222 | Two per-principal budgets, in-memory |
| `src/lib/backend-client.ts` | 116 | The only outbound HTTP path |
| `src/lib/api-contract.ts` + generated types | 71 + 27,974 | Types derived from a vendored copy of the backend's OpenAPI spec |
| `src/tools/*.ts` | 807 | Seven thin client modules |

A fresh `McpServer` and transport are constructed per request with `sessionIdGenerator: undefined`, so there is no session state anywhere. On a serverless platform that is exactly right, and it is what makes the server cheap to reason about.

## 2. The request path

1. The client posts to `/api/mcp`. CORS headers come from `vercel.json`, statically.
2. `authMiddleware` resolves a principal or returns 401. There are two ways in and no third.
3. The request budget is charged. A refusal returns 429 naming which ceiling was hit.
4. The body is parsed exactly once and handed to the transport as `parsedBody`, because a `Request` body is a single-use stream.
5. The tool-call budget is charged by the number of `tools/call` members in the payload, so a JSON-RPC batch costs what it actually consumes. The charge is all-or-nothing, so a refused batch does not drain the window it was refused from.
6. The transport dispatches. Zod validates arguments before any upstream call.
7. The tool calls the backend with the caller's token; public reads carry no credential at all.

Steps 4 and 5 are recent work (SPLIT-1449) and they are correct. Step 2's constant-time key comparison and fail-closed bearer verification are also recent (SPLIT-1438) and were re-verified live during this review: a bearer whose signature is the literal string `totally-invalid-signature`, claiming `role=admin`, returns 401.

## 3. Trust boundaries

**Internet to MCP.** A caller proves possession of the operator key or of a backend-issued JWT. The operator key's `role: 'admin'` label is worth understanding precisely: it carries no backend privilege and no forwardable token, so it unlocks only the seven public read tools. Every user-scoped tool gates on `ctx.token` being present. This is a sound design — the operator key is an access key for the *server*, not an identity in the *product*.

**MCP to backend.** The MCP never accepts a caller-supplied user id; identity always travels as the token. This was a deliberate fix and it is worth not regressing.

**Backend to MCP to LLM.** Backend JSON is passed through verbatim, including error strings. This is the boundary with the least scrutiny, and section 5 returns to it.

## 4. What is strong

Worth stating plainly, because a review that lists only problems misrepresents the system.

- **The credential model is genuinely minimal.** Four environment variables are read in the entire codebase. Adding a secret here would be a visible, deliberate act.
- **The stateless-per-request server** eliminates a whole class of serverless bugs.
- **Rate limiting prices the actual work.** Most implementations count HTTP requests; this one counts tool invocations including batch members, which is what the backend actually pays for.
- **Auth fails closed on every path** — unreachable backend, non-200, malformed, expired.
- **Types are derived from the backend contract**, not hand-written, so a backend rename surfaces at compile time rather than at runtime.

## 5. Where it should improve

Ordered by what I would do first. Owner is `session` when an engineer can do it now, `operator` when it needs a secret or an account, `decision` when the product call has to come first.

### P0 — Production is a staging client wearing a production URL (`decision`)

`BACKEND_API_URL` is unset on the Vercel project, so the server falls back to `DEFAULT_BASE_URL`, which points at the staging backend. Because bearer identity is resolved by that same backend, the consequence compounds: a staging test account authenticates against production MCP and lists all 18 tools, while a real go-splitt.com user's token would be rejected. The README and `.env.example` both say the default is production.

This is not a code defect. It is an undeclared decision that the documentation contradicts. Either bind the server to the production API — setting `BACKEND_API_URL` and `MCP_BACKEND_JWT_SECRET` together, since a mismatched pair rejects every bearer — or state in the docs that the MCP is a staging-facing preview. What should not persist is a public endpoint whose target nobody has decided.

### P0 — Nothing gates the merge that deploys production (`operator`)

Merge to `main` is the production deploy, and `main` has no CI and no branch protection. On 2026-09-20 a pull request was merged while its own preview build had already failed; the production build errored on a missing module and production sat on the previous build until a follow-up landed three minutes later. A plain type-check would have caught it.

The fix costs zero GitHub Actions minutes, which matters while the org's quota is frozen: require the Vercel preview check to pass before merge. That build already runs on every pull request and is a real, non-frozen signal.

### P0 — Every tool is advertised to LLM clients without a description (`session`)

A live `tools/list` returns 18 tools of which zero carry a description. Tool selection by a model is driven almost entirely by that text, so every client is choosing between bare names. The cause is mechanical: the registration uses a positional SDK overload that has no description slot, and the SDK marks it deprecated in favour of `registerTool`. Good description text already exists in `manifest.json` and never reaches the wire.

This is the single highest-leverage change available. It is the difference between a tool surface a model can use well and one it can only guess at. Migrating also unlocks `outputSchema` and `structuredContent`, and gives a natural place to fix two related defects: failures are currently returned as ordinary content rather than `isError`, so a model cannot distinguish success from failure, and `search_listings` returns up to 50 full entities of 81 properties each, pretty-printed.

### P1 — The public repository republishes the private backend's full contract (`decision`)

This repository is public. It vendors the backend's entire OpenAPI document: 531 paths, 644 operations, 291 schemas, including 76 admin routes. The MCP consumes 20 of those paths, 3.8 percent. The backend repository is private and deliberately disables its Swagger endpoint in production for precisely this reason; its own source comments say so.

No secret is exposed and every route is authorization-enforced, so this is posture rather than vulnerability — which is why the security review did not raise it as a finding. But it is a posture nobody chose. The durable fix also solves the drift problem in the same stroke: have the backend emit an allowlisted `openapi.mcp.json` containing only the consumed operations and their transitively referenced schemas, and vendor that. The generated file drops from 27,974 lines to a few hundred, the disclosure disappears, and the manual sync commits stop being a recurring chore.

### P1 — Rate limiting and the identity cache are per-instance (`decision`)

Both live in module-level `Map`s, so on Fluid Compute the advertised ceilings are really N times higher, where N is the number of warm instances, and the 60-second identity cache misses on every new one. The code documents this honestly as best-effort. Two viable routes: Vercel Firewall rate-limit rules on the route, which is configuration only, or a shared Redis. The team already shares a Redis between environments, so this need not add a project.

### P1 — Bearer verification round-trips to the backend on every cache miss (`operator`)

With `MCP_BACKEND_JWT_SECRET` unset, each bearer request on a cold instance spends a `GET /users/profile` call before the tool's own work, and auth availability becomes backend availability. Setting the secret restores the in-process HS256 path. It must be set to the `JWT_SECRET` of whichever backend the previous decision selects — a mismatch rejects every bearer.

### P1 — Two tool-correctness defects (`session`)

`search_listings` silently discards structured filters: when `query` is set the call routes to the semantic search with only the query and a limit, so location, dates, price and category are ignored whenever that search returns anything. Separately, `guests` is accepted by the schema and never sent anywhere.

The `splitmygear://categories` resource advertises 19 categories; the backend's canonical list now has 24. A client picking a category from the resource cannot reach the ATVs category or the Stays vertical at all.

### P1 — Tool handlers have no route-level test coverage (`session`)

No test sends a `tools/call` naming any of the 18 tools through the route. The per-tool auth gating and token plumbing are therefore unverified by anything, which is the exact class of bug that previously left three tools dead behind a 401. The coverage threshold is set at 30 percent while actuals are around 83, so it cannot catch a regression either.

### P2 — Smaller items

- **Sequential timeouts can exceed the function budget.** Per-call timeouts are sized as if one call ran per request, but `send_message` can make three sequential backend calls after an 8-second identity probe, worst case 53 seconds against a 30-second `maxDuration`. Either raise the duration, which is cheap because Fluid Compute bills active CPU and not waiting, or thread one request-level deadline through the client.
- **No structured logging.** Ten `console.error` calls, all on failure. Success, latency, principal, tool name and 429 outcomes are invisible. One JSON line per request would make the service debuggable. `remaining` is already computed and thrown away; it should be a `Retry-After` and an `X-RateLimit-Remaining` header.
- **Dependency currency.** The SDK is 1.27.1 against 1.30.0, ESLint 8 is end-of-life, and two audit advisories have non-breaking fixes. Next stays below 16 per SPLIT-1294.
- **Input schemas are looser than the backend validators**, so some inputs the MCP accepts fail upstream with a 400.
- **`create_booking` fabricates a price.** The backend's DTO requires `totalPrice`, so the tool estimates one that the backend then recomputes and overrides. It is harmless today because the server recomputes, but the MCP should not be guessing at money. The clean fix is a backend quote endpoint or an optional field for API clients.

## 6. What was checked and found sound

So the next reviewer does not re-spend the effort: alias usage is consistent, with every call using the canonical `/rentals` and `/packages` families rather than the deprecated twins; the MCP never accepts a caller-supplied user id; no secret is logged anywhere; the operator key cannot reach user data; a forged JWT is rejected live; and the 2026-09-20 security review of the 2.0 branch produced zero confirmed findings across 27 agents.

## 7. Suggested order of work

1. `MCP_BACKEND_JWT_SECRET` and the `BACKEND_API_URL` decision, plus branch protection. Configuration only, no code, and it removes the two P0 risks that no amount of code quality compensates for.
2. The `registerTool` migration with descriptions, `isError` and compact search results. One focused change to one file, and the largest improvement to what clients actually experience.
3. Route-level tool tests and the coverage ratchet, so the above cannot silently regress.
4. The backend-side allowlisted spec, which retires both the disclosure and the manual sync.
5. Shared-store rate limiting, if and when the traffic justifies it.
