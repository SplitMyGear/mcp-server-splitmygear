# MCP (Model Context Protocol) Production-Ready Tasks

Aligned with the **Elite Engineer Mandate** (smg-autoresearch). Status as of the
2.0 production-readiness pass; see `tasks/todo.md` for the detailed plan and
`docs/adr/` for the design decisions.

## 1. Triple-Layer Testing
- [x] **Unit Tests**: Jest covers every tool backend module, the tool registry
      (role-aware visibility, error conversion), auth middleware, rate limiting,
      the OAuth primitives (envelopes, PKCE, client registration, tokens).
- [x] **Integration Tests**: route-level tests drive the real Next.js handlers:
      MCP initialize/tools/list/tools/call per principal, and the complete OAuth
      flow (register → sign-in → 2FA → code → token → tool call → refresh →
      revoke) against a mocked backend.
- [x] **E2E Validation**: `__tests__/e2e/mcp.test.ts` runs against a live server
      when `MCP_SERVER_URL` is set (skipped otherwise); CI runs lint, typecheck,
      unit/route tests and a production build on every push and PR.

## 2. Security & Airtight Operations
- [x] **Input Validation**: every tool declares a zod schema (UUIDs, ranges,
      enums, string caps); bodies sent to the backend carry only whitelisted DTO
      fields; dates are range-checked client-side.
- [x] **Least privilege**: the operator key sees public tools only; user tools
      forward the user's own backend session; vendor/finance/owner tools are
      only registered for the matching backend role and re-gated at call time.
- [x] **OAuth 2.1 sign-in**: PKCE-only public clients, stateless sealed
      artifacts, single-use short-lived codes, https/loopback redirects only,
      `WWW-Authenticate` discovery, RFC 7009 revocation.
- [x] **Secret Handling**: no LLM, database or payment secrets in this repo;
      `MCP_API_KEY` compared in constant time; the OAuth sealing key is
      purpose-derived; passwords/OTP codes are relayed once and never logged.
- [x] **Docs stay honest**: `docs/mcp-tools.md` and `manifest.json` are
      generated from the registry and checked in CI (`npm run gen:docs`).

## 3. Phase 2 (landed on the same PR)
- [x] Distributed rate limiting, sign-in throttle and code replay cache via an
      Upstash Redis REST shared store (fail-open to per-instance memory).
- [x] Scoped OAuth tokens: 12 scopes, consent page, refresh narrowing, scope
      aware tool listing and call-time gate.
- [x] Google / Apple sign-in on the hosted page (backend `return_to` allow-list).
- [x] 145 more tools: uploads, disputes/claims/incidental charges, rate rules and
      dynamic pricing, fleet, calendar feeds, message templates, insurance and
      waivers, saved searches/trips and trip planning, routes, vendor onboarding,
      vendor extras, booking verification, account security, services.

## 4. Follow-ups
- [ ] Account deletion, password change and 2FA enrol/disable stay in the web UI.
- [ ] KYC document upload (browser Blob flow).
- [ ] SHA-pin GitHub Actions once tag SHAs can be verified.
