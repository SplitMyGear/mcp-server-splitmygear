# mcp-server-splitmygear

The official MCP (Model Context Protocol) server for [Splitt](https://go-splitt.com), the outdoor gear rental marketplace. It lets AI assistants (Claude, Cursor, Windsurf, custom agents) act for Splitt **renters** and **vendors**: search and book gear and experiences, manage bookings, message the other party, list and price gear, run a vendor's calendar and see payouts. Everything a person can do in the Splitt web app that makes sense for an agent, with the same permissions.

- **219 tools**, filtered by who is signed in and what they granted (see [docs/mcp-tools.md](docs/mcp-tools.md))
- **Sign in with your Splitt account** from any OAuth-capable MCP client (OAuth 2.1 + PKCE; email one-time-code 2FA; Continue with Google / Apple)
- **Scoped access**: clients may request a subset of 12 scopes (`read profile bookings favorites messaging reviews listings vendor_bookings experiences finance claims files`); the sign-in page shows exactly what the app will be able to do, and tools outside the granted scopes are neither listed nor callable
- **Thin, stateless client of the Splitt backend REST API**: no database or payment credentials live here ([ADR 0001](docs/adr/0001-mcp-is-a-backend-rest-client.md), [ADR 0002](docs/adr/0002-oauth-login-for-mcp-clients.md))

Production endpoint: `https://mcp-server-splitmygear.vercel.app/api/mcp`

---

## Connect

### As a Splitt user (renter or vendor)

Add the server URL to any MCP client that supports OAuth (Claude.ai and Claude Desktop connectors, Cursor, Windsurf, the MCP Inspector). The client discovers the sign-in flow automatically, opens the hosted Splitt sign-in page, and from then on every tool acts as you.

```json
{
  "mcpServers": {
    "splitt": { "url": "https://mcp-server-splitmygear.vercel.app/api/mcp" }
  }
}
```

What the sign-in page does: your email and password go straight to Splitt's own login API (this server never stores them); if two-step verification is on, you enter the emailed code; the client receives short-lived tokens that wrap your Splitt session. Signed up with Google or Apple? Use the Continue with Google / Continue with Apple buttons (shown when Splitt has that provider configured): the round trip runs through Splitt's own provider login and ends back here, which then issues the client its code exactly as after a password sign-in. Two-step verification applies to social sign-in too.

### As an operator (server-to-server, public tools only)

```json
{
  "mcpServers": {
    "splitt": {
      "url": "https://mcp-server-splitmygear.vercel.app/api/mcp",
      "headers": { "x-api-key": "your-operator-key" }
    }
  }
}
```

The operator key unlocks the public tools (search, details, availability, calendar, quotes, reviews, market pricing, experiences). It cannot act as a user.

### With an existing Splitt session token

A first-party integration that already holds a backend JWT (from `POST /api/v1/users/login`) may send it as `Authorization: Bearer <jwt>`. This path is only open when the deployment has `MCP_BACKEND_JWT_SECRET` (the backend's `JWT_SECRET`) so the signature can be verified here; an unverified JWT never authenticates.

### Claude Desktop Extension

Install `manifest.json` through the Extension Manager. Leave the API key empty to sign in as a user, or fill it in for operator access.

---

## What you can do

The tool list a client receives already reflects the signed-in account and the granted scopes, so the model is never offered tools it cannot use.

| Who | Tools | Highlights |
|---|---|---|
| Anyone (operator key or user) | 24 | search, listing details, availability calendar, price quotes, reviews, market pricing, experiences and services, public routes, destinations, categories, trip planning |
| Signed-in user | +89 | profile and security settings, notifications, bookings (list, cancel with refund preview, reschedule responses, protection plan), pickup/return photos and inspection checklists, reviews, favorites, saved searches and trips, conversations and messages, experience and service bookings, waivers, disputes, damage-claim responses, incidental charges, evidence uploads, trust score, vendor onboarding, AI drafting helpers |
| Renter | +2 | `create_booking` (server-priced draft plus a Stripe Checkout `paymentUrl`), `get_payment_link` |
| Vendor seat (`vendor`, `vendor_owner`, `vendor_manager`, `vendor_staff`) | +98 | listings (create, update, publish, duplicate, delete, AI draft, performance), blackout dates, seasonal rate rules and dynamic pricing, fleet units, calendar feeds and iCal, routes and GPX import, insurance and waivers, message templates, incoming bookings, overdue / return status, reschedule proposals, private notes, damage claims and incidental charges, review responses, dashboard, experiences hosting, services, promotions, auto-approve, report subscriptions, tax summary |
| Vendor owner / manager | +4 | `get_vendor_earnings`, `get_vendor_payouts`, `get_payout_details`, `get_stripe_connect_status` |
| Vendor owner | +2 | `start_stripe_connect_onboarding`, `request_payout` |

Full reference with every argument: [docs/mcp-tools.md](docs/mcp-tools.md) (generated from the code by `npm run gen:docs`).

Payments never happen inside the MCP: booking tools return a Stripe-hosted `paymentUrl` for the person to open. Money, availability, pricing, ownership and permissions are all decided by the Splitt backend on every call.

---

## Security model

- **Deny by default.** No credential, no service. A 401 carries `WWW-Authenticate` with the RFC 9728 resource-metadata URL so OAuth clients can start sign-in. Raw backend JWTs are accepted only when they verify against `MCP_BACKEND_JWT_SECRET`; OAuth tokens prove their own provenance. `GET`/`DELETE` on `/api/mcp` answer 405 (stateless transport).
- **The backend is the authority.** Every user-scoped call forwards the user's own Splitt JWT; the backend re-validates it and enforces role, ownership and lifecycle rules. This server never accepts a caller-supplied user id.
- **Scopes.** Every tool belongs to one OAuth scope (see the Scopes table in docs/mcp-tools.md). Clients request scopes with the standard space-separated `scope` parameter on `/oauth/authorize`; a client that sends none is granted all scopes and the consent page says so in plain words. The `scope` member of the token response echoes the grant. A `refresh_token` request may pass `scope` to narrow the grant (never widen it), and the narrowed set persists in the new refresh token. The operator API key has `read` only; a verified raw backend JWT has every scope. Scopes never override the backend role model: granting `listings` to a renter account unlocks nothing, and the backend re-checks every forwarded call.
- **Stateless OAuth.** Authorization codes, access tokens, refresh tokens, registered client ids and in-flight sign-in requests are AES-256-GCM envelopes sealed with `MCP_OAUTH_SIGNING_KEY` (purpose-bound keys, so a code can never be replayed as a token). PKCE S256 is mandatory; only `https` or loopback redirect URIs register; codes live 2 minutes and are single-use.
- **Your password is never stored.** The hosted sign-in page relays it once to Splitt's login API, together with your real IP via the backend's trusted relay header (`MCP_BFF_RELAY_KEY`) so Splitt's brute-force throttling keys on you, not on this server. The form only accepts same-origin submissions (a hostile page cannot drive it with its visitors' browsers), failed attempts are throttled per IP and per account, and a successful login never resets the budget.
- **Social sign-in cannot skip the consent card.** Continue with Google / Apple can only be started by a click on the sign-in page itself (the start route requires a same-origin navigation), and the browser that clicked is tied to the return trip by a nonce carried in the sealed request and in a short-lived HttpOnly cookie; the callback refuses anything else. The one-time exchange code the backend hands back is swapped once and expires after a minute. The backend must list this server's origin in `SOCIAL_AUTH_RETURN_ORIGINS` or it will not send the browser back here.
- **Phishing resistance.** The sign-in page shows the app's name and the exact address it will send you to, and labels the app "unverified" unless its redirect host is on the operator allow-list (`MCP_OAUTH_ALLOWED_REDIRECT_HOSTS`, which also restricts who may register). Proxy headers are only trusted on Vercel or with `MCP_TRUST_PROXY_HEADERS=1`.
- **Hardened responses.** Strict CSP on the sign-in page (no scripts, no remote assets), `no-store` everywhere, `X-Frame-Options: DENY`, HSTS, constant-time secret comparison, sanitized error messages.
- **Model safety.** Destructive tools carry MCP `destructiveHint`; results that contain other users' text are labelled as untrusted data; server instructions tell the model to confirm cancellations and never collect card numbers.
- **Rate limiting and throttles across instances.** With a shared store configured (`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`, or the Vercel KV names), the per-principal MCP rate limit, the sign-in failure throttle (10 failures per 10 minutes per IP and per account) and the authorization-code replay cache are enforced across every serverless instance. Without it, or while the store is unreachable, each instance falls back to its own memory and one warning per minute is logged; the backend's throttles remain the real control.

Report security issues to security@go-splitt.com.

---

## Running locally

```bash
git clone https://github.com/SplitMyGear/mcp-server-splitmygear
cd mcp-server-splitmygear
npm install
cp .env.example .env.local   # fill in MCP_API_KEY and, for sign-in, MCP_OAUTH_SIGNING_KEY
npm run dev                  # http://localhost:3000/api/mcp
```

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `MCP_API_KEY` | yes | Operator key (`x-api-key`). Without it every request is refused. |
| `MCP_OAUTH_SIGNING_KEY` | for sign-in | 32+ random bytes; seals every OAuth artifact. Rotating it invalidates all issued tokens. |
| `MCP_PUBLIC_URL` | production | Public origin of this server (the OAuth issuer), e.g. `https://mcp-server-splitmygear.vercel.app`. Falls back to Vercel's production URL. |
| `MCP_BFF_RELAY_KEY` | recommended | The backend's `BFF_RELAY_KEY`; relays the end user's IP on login. |
| `MCP_OAUTH_ALLOWED_REDIRECT_HOSTS` | recommended | Comma-separated redirect hosts allowed to register (leading dot = subdomains), e.g. `claude.ai,.claude.com,cursor.com`. Loopback is always allowed. Unset = any https host, shown as "unverified". |
| `MCP_TRUST_PROXY_HEADERS` | off-Vercel only | `1` to trust `x-real-ip` / `x-forwarded-for` behind your own proxy. Automatic on Vercel. |
| `BACKEND_API_URL` | no | Backend base, default `https://splitmygear-backend.vercel.app/api/v1`. |
| `MCP_BACKEND_JWT_SECRET` | for raw JWTs | Backend `JWT_SECRET`. Required to accept raw backend JWT bearers (they are signature-checked here); also verifies the JWTs inside OAuth tokens. |
| `MCP_RATE_LIMIT_TIER` | no | `internal` (100/min), `beta` (50), `public` (20), default 10. |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | recommended in prod | Shared store for the distributed rate limit, the sign-in throttle and the code replay cache. Vercel KV names `KV_REST_API_URL` / `KV_REST_API_TOKEN` are accepted as a fallback pair. Unset: every limit is per serverless instance. |

### Checks

```bash
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm test            # jest (unit + route + full OAuth flow against a mocked backend)
npm run build       # next build
npm run verify      # all of the above
npm run gen:docs    # regenerate docs/mcp-tools.md + manifest.json from the tool registry
npm run gen:api     # regenerate backend API types from openapi/openapi.json
```

CI (`.github/workflows/ci.yml`) runs the same on every push and pull request. Vercel's Git integration deploys `main`.

### Distributed rate limiting (Upstash)

Create a Redis database at console.upstash.com (the free tier is enough), open its REST API tab and copy the REST URL and token into `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` on the Vercel project. The Upstash integration from the Vercel Marketplace, which injects `KV_REST_API_URL` / `KV_REST_API_TOKEN`, works too. No npm dependency: the server talks to the REST API directly, one round trip per request, capped at 1.5 s. Keys are namespaced `mcp:` and never logged.

### Social sign-in

The backend must list this server's exact public origin in `SOCIAL_AUTH_RETURN_ORIGINS` (see the backend's `.env.example`) and have Google or Apple configured; the buttons appear automatically when `GET /api/v1/auth/providers` reports a provider.

---

## Endpoints

| Path | Purpose |
|---|---|
| `POST /api/mcp` | MCP Streamable HTTP (stateless, JSON responses) |
| `GET /.well-known/oauth-protected-resource[/api/mcp]` | RFC 9728 protected-resource metadata |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 authorization-server metadata |
| `POST /oauth/register` | RFC 7591 dynamic client registration (public clients) |
| `GET/POST /oauth/authorize` | Hosted Splitt sign-in (authorization code + PKCE; optional `scope`) |
| `GET /oauth/social/start` | Start Google/Apple sign-in from the hosted page (same-origin only) |
| `GET /oauth/social/callback` | Return leg: exchange code, Splitt session, authorization code for the client |
| `POST /oauth/token` | `authorization_code` and `refresh_token` grants (`scope` may narrow on refresh) |
| `POST /oauth/revoke` | RFC 7009 revocation |

The server's own HTTP contract is described in [docs/openapi.json](docs/openapi.json); the backend contract it consumes is snapshotted in [openapi/openapi.json](openapi/openapi.json).

---

## License

MIT
