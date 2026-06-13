# ADR 0001 — The MCP server is a thin client of the backend REST API

- **Status:** Accepted (2026-06-13)
- **Ticket:** SPLIT-226
- **Supersedes:** the original design where MCP tools read/wrote Supabase directly

## Context

The `mcp-server-splitmygear` MCP server originally talked to the database
directly: it constructed a Supabase client with the **service-role key** (which
bypasses all Row-Level Security) and its tools read **and wrote** tables
(`booking`, `conversation`, `message`, `experience_booking`, `listing`) plus the
`match_listings` pgvector RPC, and called Stripe directly for payment intents.

This was wrong on two counts:

1. **Security / correctness.** Direct service-role writes bypassed every domain
   rule the backend enforces — JWT auth, RBAC, ownership checks,
   server-authoritative pricing (SPLIT-157), booking overlap/capacity locks,
   blackout dates, protection-plan math, CRM events, DTO validation. The tools
   also passed a caller-supplied `userId`, which is an impersonation vector.
2. **Schema drift.** The MCP's assumed column names (`booking.userId`,
   `checkIn`, `checkOut`, `guests`; `conversation.participant1Id`) had diverged
   from the real backend entities (`renterId`, `startDate`, `endDate`; the chat
   model). The writes targeted a schema that no longer existed.

## Decision

**Every MCP tool is a thin client of the backend REST API (`/api/v1`). The MCP
holds no service-role database client and performs no direct DB writes.**

- **Mutations & identity-scoped reads** forward the caller's own backend JWT
  (`Authorization: Bearer`) to the backend, which is the single authority for
  auth, RBAC, ownership, pricing and payment. The MCP never accepts a
  caller-supplied user id; the acting user is always derived from the token.
- **Public reads** (listing/experience search, details, availability, similar,
  pricing stats) call the backend's public `GET` endpoints — the canonical,
  moderation-filtered source — built via `URLSearchParams` (so query values are
  always encoded and cannot inject into a filter).
- A shared `src/lib/backend-client.ts` performs every call (Bearer injection +
  backend error-shape parsing → `BackendApiError`).
- Auth: deny-by-default. A request presents the operator `MCP_API_KEY` (admin,
  no per-user token) or a user backend JWT. `src/lib/jwt.ts` decodes the JWT for
  the acting user and optionally verifies its HS256 signature when
  `MCP_BACKEND_JWT_SECRET` is set (the backend re-validates regardless).

## Consequences

- `src/lib/supabase.ts` (service-role client) and `src/lib/ai-service.ts`
  (client-side NLP/embedding, now done server-side behind `/listings/search/vibe`
  and `/listings/:id/similar`) were deleted.
- `SUPABASE_SERVICE_ROLE_KEY` and `STRIPE_SECRET_KEY` are no longer used by any
  code and must be removed from the deployment and the service-role key rotated
  (operator).
- The only remaining Supabase reference is the optional operator `api_keys`
  lookup in `auth.ts`, which uses the **anon** key. Migrating or removing that is
  a minor follow-up to drop `@supabase/supabase-js` entirely.

## Rule for all future surfaces

Any new client (MCP, mobile, internal tool, automation) consumes the backend
REST API with a scoped token. It must never embed a service-role key or write to
the database directly. New backend capabilities are exposed as REST endpoints
with DTO validation and authorization, then consumed by clients — never
duplicated client-side.
