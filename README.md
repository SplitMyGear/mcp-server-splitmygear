# mcp-server-splitmygear

MCP (Model Context Protocol) server for [SplitMyGear](https://splitmygear.com) — an outdoor gear rental marketplace. Lets AI agents (Claude, Cursor, Windsurf, etc.) search gear, check availability, manage bookings, browse experiences, and more.

**18 tools** across search, booking, pricing, content generation, experiences, and messaging.

> Independent project — not affiliated with any third party.

---

## Quick Start

### Claude Desktop

> **Authentication is required.** Every request must present either an API key
> (`x-api-key`) or a user JWT (`Authorization: Bearer …`). There is no public
> tier — the server wields privileged credentials, so unauthenticated requests
> are rejected with 401.

Add to your `claude_desktop_config.json` (API key required):

```json
{
  "mcpServers": {
    "splitmygear": {
      "url": "https://mcp-server-splitmygear.vercel.app/api/mcp",
      "headers": {
        "x-api-key": "your-splitmygear-api-key"
      }
    }
  }
}
```

### Cursor / Windsurf / mcp.json

```json
{
  "mcpServers": {
    "splitmygear": {
      "url": "https://mcp-server-splitmygear.vercel.app/api/mcp",
      "headers": {
        "x-api-key": "your-splitmygear-api-key"
      }
    }
  }
}
```

### Claude Desktop Extension (DXT)

Install `manifest.json` through Claude Desktop's Extension Manager (Claude Desktop v0.10.0+). The UI exposes the required API key field.

### HTTP (direct)

```bash
curl -X POST https://mcp-server-splitmygear.vercel.app/api/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "search_listings",
      "arguments": { "query": "tent for a family camping trip this weekend" }
    }
  }'
```

---

## Authentication

**All access requires authentication** — the server holds privileged platform
credentials, so there is no public/anonymous tier. Present either:

- an operator **API key** via the `x-api-key` header (unlocks read/search,
  pricing, and content tools), or
- a user **JWT** via `Authorization: Bearer <token>` (additionally unlocks
  user-scoped tools — booking, messaging, personalized recommendations — which
  act as the authenticated user; they never accept a caller-supplied user id).

Unauthenticated requests are rejected with `401`. The two tiers below mean
"works with an API key" (**Auth**) vs "requires a user JWT" (**User**).

---

## Available Tools (18)

### Search & Listings

| Tool | Auth | Description |
|------|------|-------------|
| `search_listings` | Auth | Search gear by filters or natural language |
| `get_listing_details` | Auth | Full details for a listing |
| `check_availability` | Auth | Check if a listing is available for dates |
| `get_similar_listings` | Auth | Semantically similar gear |
| `get_personalized_recommendations` | User | Recommendations based on booking history |

### Bookings

| Tool | Auth | Description |
|------|------|-------------|
| `create_booking` | User | Create a rental booking (Stripe payment) |
| `cancel_booking` | User | Cancel a booking with optional refund |
| `get_booking_status` | User | Status of YOUR booking (owner-checked) |

### Pricing & Business Intelligence

| Tool | Auth | Description |
|------|------|-------------|
| `suggest_listing_price` | Auth | AI-powered price suggestion for a gear category |
| `analyze_competitor_pricing` | Auth | Compare a listing against local competitors |

### Content Generation

| Tool | Auth | Description |
|------|------|-------------|
| `generate_listing_description` | Auth | AI description from name + keywords |
| `improve_listing_title` | Auth | SEO-optimized title suggestions |

### Experiences

| Tool | Auth | Description |
|------|------|-------------|
| `search_experiences` | Auth | Browse outdoor adventures and tours |
| `get_experience_details` | Auth | Full info and available schedules |
| `book_experience` | User | Book spots on a scheduled experience |

### Messaging

| Tool | Auth | Description |
|------|------|-------------|
| `send_message` | User | Send a message to a renter or vendor |
| `get_conversations` | User | List your active conversations |
| `generate_ai_message_draft` | Auth | AI-drafted professional message |

---

## Natural Language Search

The `search_listings` `query` parameter accepts plain English. The server parses it into structured filters automatically:

```
"lightweight tent for solo backpacking next weekend under $40/day"
"water sports gear for 3 people in Seattle"
"climbing harness and helmet for a beginner"
```

---

## Resources

| Resource URI | Description |
|---|---|
| `splitmygear://categories` | List of all 8 gear categories |

---

## Running Locally

### Prerequisites
- Node.js 18+
- An operator `MCP_API_KEY` (and, for user-scoped tools, a backend JWT)
- Access to the SplitMyGear backend REST API (defaults to production; override with `BACKEND_API_URL`)
- *(optional)* An AI provider key (OpenCode Zen / OpenRouter / OpenAI) for the two content tools and the AI message draft

> This server holds **no** Supabase or Stripe credentials — every action goes
> through the backend REST API, which is the single authority for auth, data,
> pricing and payments (SPLIT-226).

### Setup

```bash
git clone https://github.com/SplitMyGear/mcp-server-splitmygear
cd mcp-server-splitmygear
npm install
cp .env.example .env.local
# Fill in your env vars
npm run dev
```

Your local server will be at `http://localhost:3000/api/mcp`.

### Environment Variables

```env
MCP_API_KEY=               # REQUIRED — operator key clients send via x-api-key
BACKEND_API_URL=           # optional — defaults to the production backend /api/v1
MCP_BACKEND_JWT_SECRET=    # optional — verify forwarded JWT signatures locally (defense in depth)
# AI provider for the content/draft tools (first key present wins): OPENCODE → OPENROUTER → OPENAI
OPENCODE_API_KEY=          # https://opencode.ai/zen — free tier
OPENROUTER_API_KEY=        # https://openrouter.ai — free tier
AI_CHAT_MODEL=             # optional override
AI_EMBEDDING_MODEL=        # optional override
MCP_RATE_LIMIT_TIER=public # internal | beta | public | default
```

> Without `MCP_API_KEY` the server fails closed (every request 401s). Without an
> AI provider key the three AI content tools degrade gracefully (they return a
> "disabled" notice); every other tool is unaffected.

### Tests

```bash
npm test
```

---

## Deployment (Vercel)

This server is optimized for Vercel Serverless Functions. Push to the connected GitHub repo to trigger a deploy:

```bash
git push origin main
```

---

## Rate Limits

| Tier | Requests/min | Tool calls/min |
|------|-------------|----------------|
| `public` | 20 | 200 |
| `beta` | 50 | 500 |
| `internal` | 100 | 1000 |

Set `MCP_RATE_LIMIT_TIER` in your environment to control the limit.

---

## License

MIT
