# ADR 0003: Scoped tokens, a shared limiter store, and social sign-in on the hosted page

- **Status:** Accepted (2026-09-05)
- **Builds on:** ADR 0001 (thin backend client), ADR 0002 (stateless OAuth AS)

## Context

ADR 0002 shipped sign-in with three follow-ups deferred: authorization was
purely the backend's role model (no OAuth scopes), every rate limit and the
authorization-code replay cache were per serverless instance, and users who
signed up with Google or Apple could not use the hosted page without first
setting a password. The tool surface has also grown well beyond the 74 tools
of the first cut, which makes least-privilege connections more valuable.

## Decisions

### Scoped tokens

- Every tool declares exactly one **scope** from a fixed taxonomy:
  `read`, `profile`, `bookings`, `favorites`, `messaging`, `reviews`,
  `listings`, `vendor_bookings`, `experiences`, `finance`, `claims`, `files`.
  The taxonomy follows what a person would reason about when granting access
  ("let it manage my listings, not my money"), not the backend's controller
  layout.
- A client may request a subset with the standard `scope` parameter. Unknown
  values are an `invalid_scope` error. **No `scope` means full access**, which
  the consent card says in plain words; otherwise the card lists each granted
  capability. Granted scopes ride inside the sealed code, access and refresh
  envelopes; a refresh may only narrow them.
- The registry hides tools outside the granted scopes from `tools/list` and
  refuses them at call time; role/access checks still apply on top, and the
  backend enforces authorization again on every forwarded call. Scopes are a
  least-privilege convenience for the person connecting, not a new security
  boundary.
- The operator key is treated as `read` only; a verified raw backend JWT
  carries all scopes (it is a first-party session).

### Shared store for limits

- An optional Upstash Redis REST store (no npm dependency; Vercel KV env
  names accepted) backs three things that were per-instance: the MCP
  endpoint's fixed-window rate limit, the sign-in throttles, and the
  authorization-code single-use check. Keys are prefixed `mcp:`.
- **Fail open, loudly**: if the store is unreachable the in-memory fallback
  is used and a warning is logged, because the backend's own distributed
  throttles remain the real control and an outage of a convenience store must
  never take sign-in down.
- The sign-in throttle counts FAILURES only in both layers (a check reads the
  counter; a failed attempt increments it), so a legitimate owner is never
  locked out by successful logins from a shared office address.

### Social sign-in on the hosted page

- The backend gained an allow-listed `return_to` on `GET /auth/google` and
  `GET /auth/apple` (`SOCIAL_AUTH_RETURN_ORIGINS`, matched by origin plus an
  optional path prefix and capped at 4096 characters), persisted on the CSRF
  state row and honoured by the callbacks, which append `code` or `error` to
  it with proper URL handling.
- The hosted page offers "Continue with Google / Apple" only when the backend
  reports the provider configured. `/oauth/social/start` sends the browser to
  the backend with `return_to = <this server>/oauth/social/callback?req=<sealed
  sign-in request>`; the callback swaps the one-time exchange code for a
  session via `POST /auth/oauth/exchange` and then behaves exactly like a
  password sign-in (same scopes, same code issuance, same client redirect).
- The callback is a top-level navigation from the backend, so no same-origin
  check can apply there. Because the backend allow-lists only the `return_to`
  ORIGIN, the consent step is protected on the start leg instead:
  `/oauth/social/start` accepts only a same-origin navigation
  (`Sec-Fetch-Site: same-origin`, i.e. a click on the consent page) and binds
  that browser to the round trip with a nonce carried in the re-sealed `req`
  and in a short-lived HttpOnly SameSite=Lax cookie that the callback must
  see. A deep link to the backend cannot set our cookie and a deep link to
  `/start` is refused, so an attacker cannot route a victim's Google consent
  into a code bound to the attacker's client. The single-use exchange code and
  the sealed request complete the protection.

## Consequences

- **Amended by SPLIT-1420:** running without the shared store is still allowed
  but no longer silent — every affected path logs a startup warning naming the
  degraded protections — and `MCP_REQUIRE_SHARED_STORE=1` makes its absence
  refuse to enable OAuth at all.
- New env vars: `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (or
  `KV_REST_API_*`) on this server; `SOCIAL_AUTH_RETURN_ORIGINS` on the backend
  must include this server's callback, path pinned
  (`https://<this host>/oauth/social/callback`).
- Existing connections keep working: tokens issued before scopes carried no
  scope claim and are treated as full access; a refresh re-seals that full
  access unless the client narrows it with `scope`. They age out with the
  refresh token's 30-day lifetime.
- The `bookings` scope covers booking operations the user is a party to as
  renter OR vendor (pickup/return verification, waivers, service bookings);
  `vendor_bookings` is vendor-only booking administration. `export_my_data`
  additionally requires a full-access grant because the export spans every
  scope.
- Finance reads (earnings, payouts, Stripe status) are owner-seat only: the
  backend's seat matrix grants the payouts permission to owners alone, so a
  manager seat would pass the role gate and be refused.
- Adding a tool now requires choosing its scope; the registry test enforces
  that every tool has one from the taxonomy.
