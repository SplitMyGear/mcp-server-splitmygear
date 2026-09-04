# mcp-server-splitmygear

The official MCP (Model Context Protocol) server for [Splitt](https://go-splitt.com), the outdoor gear rental marketplace. It lets AI assistants (Claude, Cursor, Windsurf, custom agents) act for Splitt **renters** and **vendors**: search and book gear and experiences, manage bookings, message the other party, list and price gear, run a vendor's calendar and see payouts. Everything a person can do in the Splitt web app that makes sense for an agent, with the same permissions.

- **74 tools**, filtered by who is signed in (see [docs/mcp-tools.md](docs/mcp-tools.md))
- **Sign in with your Splitt account** from any OAuth-capable MCP client (OAuth 2.1 + PKCE, email one-time-code 2FA supported)
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

What the sign-in page does: your email and password go straight to Splitt's own login API (this server never stores them); if two-step verification is on, you enter the emailed code; the client receives short-lived tokens that wrap your Splitt session. Signed up with Google or Apple? Set a password first from your Splitt profile.

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

A first-party integration that already holds a backend JWT (from `POST /api/v1/users/login`) may send it as `Authorization: Bearer <jwt>`; it is forwarded unchanged.

### Claude Desktop Extension

Install `manifest.json` through the Extension Manager. Leave the API key empty to sign in as a user, or fill it in for operator access.

---

## What you can do

The tool list a client receives already reflects the signed-in account, so the model is never offered tools it cannot use.

| Who | Tools | Highlights |
|---|---|---|
| Anyone (operator key or user) | 11 | `search_listings`, `get_listing_details`, `check_availability`, `get_listing_calendar`, `get_booking_quote`, `get_listing_reviews`, `suggest_listing_price`, `search_experiences` |
| Signed-in user | +33 | profile, notifications, `list_my_bookings`, `cancel_booking` (with `preview_cancellation`), reschedule responses, reviews, favorites, conversations and messages, experience bookings, AI drafting helpers |
| Renter | +2 | `create_booking` (server-priced draft plus a Stripe Checkout `paymentUrl`), `get_payment_link` |
| Vendor seat (`vendor`, `vendor_owner`, `vendor_manager`, `vendor_staff`) | +24 | listings (create, update, publish, duplicate, delete, AI draft, performance), blackout dates, incoming bookings, overdue / return status, reschedule proposals, private notes, review responses, dashboard, experiences hosting (create, schedules, publish, host bookings) |
| Vendor owner / manager | +3 | `get_vendor_earnings`, `get_vendor_payouts`, `get_stripe_connect_status` |
| Vendor owner | +1 | `start_stripe_connect_onboarding` |

Full reference with every argument: [docs/mcp-tools.md](docs/mcp-tools.md) (generated from the code by `npm run gen:docs`).

Payments never happen inside the MCP: booking tools return a Stripe-hosted `paymentUrl` for the person to open. Money, availability, pricing, ownership and permissions are all decided by the Splitt backend on every call.

---

## Security model

- **Deny by default.** No credential, no service. A 401 carries `WWW-Authenticate` with the RFC 9728 resource-metadata URL so OAuth clients can start sign-in.
- **The backend is the authority.** Every user-scoped call forwards the user's own Splitt JWT; the backend re-validates it and enforces role, ownership and lifecycle rules. This server never accepts a caller-supplied user id.
- **Stateless OAuth.** Authorization codes, access tokens, refresh tokens, registered client ids and in-flight sign-in requests are AES-256-GCM envelopes sealed with `MCP_OAUTH_SIGNING_KEY` (purpose-bound keys, so a code can never be replayed as a token). PKCE S256 is mandatory; only `https` or loopback redirect URIs register; codes live 2 minutes and are single-use.
- **Your password is never stored.** The hosted sign-in page relays it once to Splitt's login API, together with your real IP via the backend's trusted relay header (`MCP_BFF_RELAY_KEY`) so Splitt's brute-force throttling keys on you, not on this server.
- **Hardened responses.** Strict CSP on the sign-in page (no scripts, no remote assets), `no-store` everywhere, `X-Frame-Options: DENY`, HSTS, constant-time secret comparison, sanitized error messages.
- **Model safety.** Destructive tools carry MCP `destructiveHint`; results that contain other users' text are labelled as untrusted data; server instructions tell the model to confirm cancellations and never collect card numbers.
- **Rate limiting** per principal (best effort per serverless instance; the backend has its own distributed limits).

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
| `BACKEND_API_URL` | no | Backend base, default `https://splitmygear-backend.vercel.app/api/v1`. |
| `MCP_BACKEND_JWT_SECRET` | no | Backend `JWT_SECRET`; verifies forwarded JWT signatures locally as defense in depth. |
| `MCP_RATE_LIMIT_TIER` | no | `internal` (100/min), `beta` (50), `public` (20), default 10. |

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

---

## Endpoints

| Path | Purpose |
|---|---|
| `POST /api/mcp` | MCP Streamable HTTP (stateless, JSON responses) |
| `GET /.well-known/oauth-protected-resource[/api/mcp]` | RFC 9728 protected-resource metadata |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 authorization-server metadata |
| `POST /oauth/register` | RFC 7591 dynamic client registration (public clients) |
| `GET/POST /oauth/authorize` | Hosted Splitt sign-in (authorization code + PKCE) |
| `POST /oauth/token` | `authorization_code` and `refresh_token` grants |
| `POST /oauth/revoke` | RFC 7009 revocation |

The server's own HTTP contract is described in [docs/openapi.json](docs/openapi.json); the backend contract it consumes is snapshotted in [openapi/openapi.json](openapi/openapi.json).

---

## License

MIT
