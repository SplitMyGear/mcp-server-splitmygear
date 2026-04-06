# mcp-server-splitmygear

MCP (Model Context Protocol) server for [SplitMyGear](https://splitmygear.com) — an outdoor gear rental marketplace. Lets AI agents (Claude, Cursor, Windsurf, etc.) search gear, check availability, manage bookings, browse experiences, and more.

**18 tools** across search, booking, pricing, content generation, experiences, and messaging.

> Independent project — not affiliated with any third party.

---

## Quick Start

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "splitmygear": {
      "url": "https://mcp-server-splitmygear.vercel.app/api/mcp"
    }
  }
}
```

With an API key (unlocks booking, messaging, and personalized tools):

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
      "url": "https://mcp-server-splitmygear.vercel.app/api/mcp"
    }
  }
}
```

### Claude Desktop Extension (DXT)

Install `manifest.json` through Claude Desktop's Extension Manager (Claude Desktop v0.10.0+). The UI exposes an optional API key field.

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

Most tools work **without authentication** — search, browse, check availability, pricing, and content generation are all public.

To unlock booking, messaging, and personalized recommendation tools, provide a `SplitMyGear API key` via the `x-api-key` header, or a user JWT via `Authorization: Bearer <token>`.

---

## Available Tools (18)

### Search & Listings

| Tool | Auth | Description |
|------|------|-------------|
| `search_listings` | Public | Search gear by filters or natural language |
| `get_listing_details` | Public | Full details for a listing |
| `check_availability` | Public | Check if a listing is available for dates |
| `get_similar_listings` | Public | Semantically similar gear |
| `get_personalized_recommendations` | API key | Recommendations based on booking history |

### Bookings

| Tool | Auth | Description |
|------|------|-------------|
| `create_booking` | API key | Create a rental booking (Stripe payment) |
| `cancel_booking` | API key | Cancel a booking with optional refund |
| `get_booking_status` | Public | Get the status of any booking |

### Pricing & Business Intelligence

| Tool | Auth | Description |
|------|------|-------------|
| `suggest_listing_price` | Public | AI-powered price suggestion for a gear category |
| `analyze_competitor_pricing` | Public | Compare a listing against local competitors |

### Content Generation

| Tool | Auth | Description |
|------|------|-------------|
| `generate_listing_description` | Public | AI description from name + keywords |
| `improve_listing_title` | Public | SEO-optimized title suggestions |

### Experiences

| Tool | Auth | Description |
|------|------|-------------|
| `search_experiences` | Public | Browse outdoor adventures and tours |
| `get_experience_details` | Public | Full info and available schedules |
| `book_experience` | API key | Book spots on a scheduled experience |

### Messaging

| Tool | Auth | Description |
|------|------|-------------|
| `send_message` | API key | Send a message to a renter or vendor |
| `get_conversations` | API key | List your active conversations |
| `generate_ai_message_draft` | Public | AI-drafted professional message |

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
- Supabase project
- Stripe account (for booking tools)
- OpenRouter API key (free tier, for AI features)

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
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
STRIPE_SECRET_KEY=
OPENROUTER_API_KEY=        # https://openrouter.ai — free tier available
MCP_RATE_LIMIT_TIER=public # internal | beta | public
```

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
