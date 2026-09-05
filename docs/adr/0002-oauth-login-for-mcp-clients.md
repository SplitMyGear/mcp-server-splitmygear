# ADR 0002: OAuth 2.1 sign-in for MCP clients, implemented as a stateless authorization server

- **Status:** Accepted (2026-09-04)
- **Builds on:** ADR 0001 (the MCP server is a thin client of the backend REST API)

## Context

Until now the MCP server only accepted an operator API key or a raw backend JWT
in a header. Neither lets a Splitt renter or vendor "log in" from an MCP client
such as Claude or Cursor: users would have to obtain a JWT out of band and paste
it into a config file, and it would silently die after the backend's 15-minute
access-token lifetime. The MCP authorization specification standardises the
answer: the server is an OAuth 2.1 protected resource that advertises an
authorization server (RFC 9728), and clients run the authorization-code + PKCE
flow, refreshing tokens as needed.

Two constraints shaped the design:

1. The server runs as stateless serverless functions (Vercel). There is no
   shared session store, and adding one (Redis) just for OAuth would be a new
   piece of infrastructure with its own secrets and failure modes.
2. The backend already owns credentials, 2FA, throttling, suspension and
   session minting (`POST /users/login`, `/auth/2fa/otp/*`, `/auth/refresh`,
   `/auth/logout`). Duplicating any of that here would violate ADR 0001.

## Decision

The MCP server is both the resource server (`/api/mcp`) and a **thin, stateless
authorization server** that fronts the backend's login:

- **Every artifact is a sealed envelope, not a database row.** Authorization
  codes, access tokens, refresh tokens, registered client ids and in-flight
  sign-in requests are AES-256-GCM ciphertexts sealed with a key derived from
  `MCP_OAUTH_SIGNING_KEY` per purpose (a code cannot be presented as an access
  token; a client id cannot be forged without the key). Any instance can
  validate what any other instance issued.
- **The access token wraps the backend JWT; the refresh token wraps the backend
  refresh token.** The auth middleware opens the envelope and forwards the inner
  backend JWT exactly as before, so ADR 0001 holds: the backend re-validates
  every call. Clients never see the raw backend tokens. The `refresh_token`
  grant proxies `POST /auth/refresh`, which rotates the backend pair; revocation
  rotates and then logs the pair out.
- **The hosted sign-in page is the only place a password appears**, relayed once
  to `POST /users/login`. A `twoFactorRequired` response renders an email OTP
  step backed by `/auth/2fa/otp/send` and `/auth/2fa/otp/verify`. The end user's
  IP is relayed through the backend's trusted `x-smg-relay-key` header so its
  brute-force throttle keys on the user, not on this server's egress address.
- **Public clients only, PKCE S256 mandatory, exact redirect-URI match,
  `https` or loopback redirects only, 2-minute single-use codes** (per-instance
  replay cache; PKCE plus client/redirect binding make a replayed code useless
  without the verifier). Dynamic registration (RFC 7591) is open, as the MCP
  ecosystem expects; the user sees the client's name and redirect host on the
  sign-in page.
- **Authorization is the backend's role model, narrowed by OAuth scopes.**
  Every tool declares one of 12 scopes (`read`, `profile`, `bookings`,
  `favorites`, `messaging`, `reviews`, `listings`, `vendor_bookings`,
  `experiences`, `finance`, `claims`, `files`). The authorization code carries
  the granted scopes (`sc`) and both tokens carry them as `scp`; the middleware
  hands them to the registry, which lists and runs only tools in the granted
  set (call-time gate included). A client that requests no `scope` is granted
  everything and the consent page states that it asked for full access;
  unknown scopes are redirected as `invalid_scope`; a refresh may only narrow
  the grant (RFC 6749 §6). The operator key is `read`-only and a verified raw
  backend JWT is unrestricted. Scopes are a client-side least-privilege control
  layered on top of the role checks; the backend remains the authority.
  Envelopes sealed before scopes existed are honoured as full-access grants
  until they expire. (See ADR 0003.)
- **OAuth is opt-in.** Without `MCP_OAUTH_SIGNING_KEY` every OAuth endpoint fails
  closed and the header-based paths keep working unchanged.

## Security review outcomes folded into the design (2026-09-04)

- A raw backend JWT bearer is accepted only when it verifies against
  `MCP_BACKEND_JWT_SECRET`; without the secret that path is closed. An
  unverified JWT is a string anyone can type and must not unlock even the
  public tools or its own rate-limit bucket. OAuth envelopes do not need the
  secret: their authentication tag proves this server sealed them.
- The sign-in form only accepts same-origin submissions (`Origin` /
  `Sec-Fetch-Site`), so a hostile page cannot drive it with its visitors'
  browsers to spread credential guessing across many IPs.
- Proxy headers are trusted only on Vercel or with `MCP_TRUST_PROXY_HEADERS=1`,
  values are validated as IP addresses before being relayed, and failures are
  throttled per IP and per account without ever resetting on success.
- Open registration is phishable by design (anyone can name a client
  "Claude"). The page shows the exact redirect address and labels the app
  "unverified" unless its host is on `MCP_OAUTH_ALLOWED_REDIRECT_HOSTS`, which
  also restricts registration when set.
- `client_id` is mandatory on refresh and revocation; a rejected refresh (400/
  401/403) is `invalid_grant` so clients re-authenticate instead of retrying.
- Derived keys are bound to the deployment (`MCP_PUBLIC_URL` / `VERCEL_URL`), so
  a preview sharing the production secret cannot mint production tokens; the
  issuer never advertises production endpoints from a preview.
- `GET`/`DELETE /api/mcp` answer 405: there is no SSE stream or session to hold.

## Consequences

- New routes: `/.well-known/oauth-protected-resource`,
  `/.well-known/oauth-authorization-server`, `/oauth/register`,
  `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`. A 401 from `/api/mcp`
  carries `WWW-Authenticate: Bearer resource_metadata="…"`.
- New operator secrets: `MCP_OAUTH_SIGNING_KEY` (rotating it signs everyone
  out), `MCP_PUBLIC_URL` (the issuer; must be stable), `MCP_BFF_RELAY_KEY`.
- Access tokens expire with the backend JWT (about 15 minutes); clients refresh
  transparently. A user's role change (e.g. renter becomes vendor) shows up on
  the next refresh, when the backend re-reads the user row.
- Social (Google/Apple) sign-in on the hosted page landed with ADR 0003 (the
  backend gained an allow-listed `return_to`).
- Discovery documents list `scopes_supported`; token responses include `scope`.
  docs/mcp-tools.md gains a Scopes section and a Scope column (generated).
- The per-instance code replay cache and login throttle are best-effort; the
  backend's own distributed throttles are the real control.
