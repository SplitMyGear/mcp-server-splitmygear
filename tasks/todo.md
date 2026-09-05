# Splitt MCP — production readiness plan

Goal: an elite, production-ready MCP server for Splitt that lets renters and
vendors sign in (OAuth 2.1) and do everything they can do in the web UI, with
security as the first constraint. All work on `claude/splitmygear-mcp-production-0rr5t7`.

## Findings that shaped the plan

- The 18 existing tools ship **no descriptions** to the model (deprecated
  `server.tool(name, shape, annotations, cb)` overload) — the model only sees
  names and param docs.
- Auth is header-only (operator `x-api-key` or a raw backend JWT). There is no
  way for an end user to "log in" from an MCP client → OAuth 2.1 is required.
- Backend facts (from `/home/user/splitmygear-backend`): HS256 JWT `{sub,email,
  role,entitlements}`, 15-min access tokens + rotating opaque refresh tokens
  (`POST /auth/refresh`), email-OTP 2FA challenge envelope on login, trusted
  relay headers (`x-smg-relay-key` / `x-smg-client-ip`) for end-user IP, global
  `forbidNonWhitelisted` validation (any undeclared body field → 400), one role
  per user (`renter | vendor | vendor_owner | vendor_manager | vendor_staff |
  crm_manager | admin`), rentals are instant-book (`POST /bookings` is
  renter-only and creates a DRAFT paid through Stripe Checkout).
- Frontend facts: prod API `https://api.go-splitt.com`, site `https://go-splitt.com`;
  renter/vendor action inventories captured in the tool plan below.
- No CI workflow, no ESLint config, stale docs (`docs/mcp-tools.md` still lists
  `userId` args), stale `serverExternalPackages` (supabase/stripe).

## Plan

- [x] 1. Inventory backend API + frontend UI capabilities (subagents)
- [x] 2. OAuth 2.1 layer (stateless AS fronting backend login)
  - [x] config / sealed envelopes (AES-256-GCM, purpose-bound keys) / PKCE S256
  - [x] stateless DCR (signed client ids, https or loopback redirects only)
  - [x] backend auth bridge (login, OTP send/verify, refresh, logout, relay IP)
  - [x] token issuance (code → wrapped access + refresh; refresh via backend rotation)
  - [x] metadata (RFC 9728 PRM + RFC 8414 AS), register, authorize (hosted
        sign-in + 2FA OTP page), token, revoke routes
  - [x] `WWW-Authenticate` on 401 from `/api/mcp`
  - [x] tests
- [x] 3. Auth middleware: accept MCP access envelopes + raw backend JWTs; role
      helpers (vendor family); principal-keyed rate limiting
- [x] 4. Tool registry: `registerTool` with title/description/annotations;
      role-aware `tools/list` (operator key → public tools; renter → renter set;
      vendor family → vendor set); handler-level gating as defense in depth
- [x] 5. Renter tools: profile (get/update), notifications, listing reviews +
      calendar, booking quote, create_booking (quote-priced draft + Stripe
      payment link), payment link, protection plan, my bookings, booking
      history, cancellation preview, cancel, reschedule response, reviews
      (create/mine/update/delete), favorites (list/toggle), conversation
      messages / mark read / unread counts, experience bookings (mine/cancel +
      payment link)
- [x] 6. Vendor tools: onboarding status, my listings, create/update/publish/
      unpublish/delete/duplicate listing, AI listing draft, listing
      performance, blackout dates (list/add/remove), incoming bookings, return
      status, reschedule propose/withdraw, vendor notes, cancel with reason,
      review responses, earnings, payouts, Stripe Connect status/onboard,
      dashboard, experiences (mine/create/update/publish/archive/schedules/
      host bookings/confirm-cancel-complete)
- [x] 7. Security pass: explicit OPTIONS/CORS incl. `mcp-*` headers, no-store
      + security headers, login throttle, relay IP, sanitized errors, remove
      stale supabase/stripe config, ADR 0002, independent review + fixes
- [x] 8. Tests for every new module (unit) + route-level OAuth flow test
- [x] 9. CI workflow (lint/typecheck/test/build) + ESLint config
- [x] 10. Docs: README, docs/mcp-tools.md, manifest.json, smithery.yaml,
      .env.example, docs/openapi.json, TASKS.md
- [x] 11. Verify (tsc, jest, lint, build, tools/list probe, simulated OAuth
      flow), commit, push

## Phase 2: deferred items (in progress, PR #34)

Orchestrated as one parallel workflow (15 agents on disjoint files) plus an
integration + adversarial review pass by the main loop.

- [ ] Scoped OAuth tokens: scope taxonomy declared on every tool (done);
      enforcement in envelopes, authorize/consent page, token/refresh
      narrowing, middleware, registry visibility, metadata, generated docs
- [ ] Distributed rate limiting: Upstash Redis REST shared store (no deps),
      fixed-window MCP limiter with in-memory fail-open fallback; login
      throttle and code replay cache wired to the same store
- [ ] Social sign-in on the hosted page: backend `return_to` (allow-listed
      origins, persisted on the CSRF state row, migration) + MCP
      /oauth/social/start and /oauth/social/callback using the one-time
      exchange code
- [ ] New tool domains: uploads + disputes/claims/incidental charges, rate
      rules + dynamic pricing, fleet, calendar feeds, message templates,
      insurance + waivers, saved searches/trips + trip planning, routes,
      vendor onboarding, vendor extras (payout details, promotions, tax,
      trust), booking verification, account security, services
- [ ] Integrate (defs index, docs regen, README/ADR/env), verify, commit, push
- [ ] Adversarial review workflow over the diff; fix; push; backend PR;
      update PR #34 body

## Deferred (documented follow-ups, not in this pass)

- Distributed rate limiting (needs a shared store such as Upstash)
- Seasonal rate rules, dynamic pricing config, fleet units, iCal feeds,
  message templates, insurance, waivers, claims/disputes/incidental charges
  (evidence uploads need file transfer), search alerts, saved trips, routes
- Scoped OAuth tokens (per-capability scopes) — authorization today is the
  backend's role model, re-checked on every forwarded call
- Social (Google/Apple) sign-in on the hosted login page (users set a
  password first)

## Review

**Shipped on `claude/splitmygear-mcp-production-0rr5t7` (MCP repo only; no
backend/frontend/CRM changes were needed).**

- 74 role-aware tools (was 18, none of which had a description): 11 public,
  33 signed-in-user, 2 renter-only, 24 vendor, 3 owner/manager finance,
  1 owner. `tools/list` is filtered per principal; handlers re-gate; the
  backend enforces everything again.
- OAuth 2.1 sign-in for MCP clients: RFC 9728/8414 discovery, RFC 7591 DCR
  (signed stateless client ids), hosted Splitt sign-in page with email-OTP 2FA,
  PKCE-S256-only codes, wrapped access/refresh tokens, RFC 7009 revocation,
  `WWW-Authenticate` on 401. All artifacts are AES-256-GCM envelopes; no
  session store. End-user IP relayed to the backend's login throttle.
- Bookings now price through the backend's authoritative quote and hand back a
  Stripe Checkout `paymentUrl`; the same for experiences.
- Hardening: explicit CORS incl. `mcp-*` headers, `no-store`, CSP on the
  sign-in page, HSTS/nosniff/frame-deny site-wide, principal-keyed rate limit,
  per-IP login throttle, body-size caps, sanitized errors, stale supabase/stripe
  config removed, secrets never logged.
- Quality gates: ESLint config + CI (lint, typecheck, jest+coverage, build,
  prod dependency audit); 179 tests incl. a full OAuth flow against a mocked
  backend; docs and DXT manifest generated from the registry and diffed in CI.
- Independent security review (subagent) found 0 critical/high, 4 medium,
  8 low; all fixed: raw JWT path now requires signature verification,
  same-origin gate on the sign-in form, proxy-header trust gated and validated,
  redirect-host allow-list + "unverified app" labelling, client_id required on
  refresh/revoke, no throttle reset on success, refresh 400 → invalid_grant,
  deployment-bound key derivation, UA sanitising, 405 on GET/DELETE, metadata
  suffix restriction, content-length prechecks, booking timeout budget, dead
  eligibility call removed, iCal URL redacted from model output.
- Verified: `npm run verify` green; built server smoke-tested (metadata, 401
  discovery headers, DCR, sign-in page rendered and screenshotted, cancel and
  outage paths, operator tools/list).

**Operator steps to go live** (documented in README / .env.example):
set `MCP_OAUTH_SIGNING_KEY` (32+ random bytes), `MCP_PUBLIC_URL`, and
`MCP_BFF_RELAY_KEY` (= backend `BFF_RELAY_KEY`) on the Vercel project;
optionally `MCP_BACKEND_JWT_SECRET`.
