import { NextRequest } from 'next/server';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { listingTools } from '@/tools/listings';
import { bookingTools } from '@/tools/bookings';
import { pricingTools } from '@/tools/pricing';
import { contentTools } from '@/tools/content';
import { experienceTools } from '@/tools/experiences';
import { messagingTools } from '@/tools/messaging';
import { authMiddleware } from '@/middleware/auth';
import { rateLimiter } from '@/middleware/rate-limit';

interface AuthContext {
  userId?: string;
  role?: string;
  /** Raw backend JWT, forwarded to the REST API by user-scoped tools (M4). */
  token?: string;
}

// Result returned by a user-scoped tool invoked without a user principal (e.g.
// the operator key, which carries no per-user token). User-scoped tools must
// NOT accept a caller-supplied id — that was the IDOR (M3). They derive the
// acting user from the authenticated bearer token and forward it to the backend
// REST API, which is the single authority for auth/RBAC/ownership (M4).
function requiresUser() {
  return {
    isError: true as const,
    content: [
      {
        type: 'text' as const,
        text: 'This tool requires user authentication: call it with a user Bearer token (from POST /api/v1/users/login), not the operator key.',
      },
    ],
  };
}

// A FRESH server + transport is built per request (see handleRequest). The
// previous module-singleton + stateful transport never completed the
// initialize handshake on serverless ("Server not initialized"), making the
// server unusable. buildServer() registers all tools on a new instance each
// time so requests are fully independent and stateless. The authenticated
// principal (ctx.userId) is closed over by user-scoped tool handlers.
function buildServer(ctx: AuthContext): McpServer {
  const server = new McpServer({
    name: 'splitmygear-mcp',
    version: '1.0.0',
    description: 'MCP Server for Splitt - AI-first rental platform',
  });

  server.tool(
  'search_listings',
  {
    location: z.string().optional().describe('City or neighborhood to search in'),
    checkIn: z.string().optional().describe('Check-in date (ISO format)'),
    checkOut: z.string().optional().describe('Check-out date (ISO format)'),
    guests: z.number().min(1).max(20).optional(),
    category: z.string().optional().describe('Category of listing (camping, hiking, water, etc.)'),
    minPrice: z.number().optional().describe('Minimum price per day'),
    maxPrice: z.number().optional().describe('Maximum price per day'),
    query: z.string().optional().describe('Natural language search query'),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ location, checkIn, checkOut, guests, category, minPrice, maxPrice, query }) => {
    const results = await listingTools.searchListings({
      location,
      checkIn,
      checkOut,
      guests,
      category,
      minPrice,
      maxPrice,
      query,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  }
);

server.tool(
  'get_listing_details',
  {
    listingId: z.string().uuid().describe('The unique identifier of the listing'),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ listingId }) => {
    const listing = await listingTools.getListingDetails(listingId);
    return {
      content: [{ type: 'text', text: JSON.stringify(listing, null, 2) }],
    };
  }
);

server.tool(
  'check_availability',
  {
    listingId: z.string().uuid().describe('The unique identifier of the listing'),
    checkIn: z.string().describe('Check-in date (ISO format)'),
    checkOut: z.string().describe('Check-out date (ISO format)'),
    guests: z.number().min(1).max(20).describe('Number of guests'),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ listingId, checkIn, checkOut, guests }) => {
    const availability = await listingTools.checkAvailability(listingId, checkIn, checkOut, guests);
    return {
      content: [{ type: 'text', text: JSON.stringify(availability, null, 2) }],
    };
  }
);

server.tool(
  'create_booking',
  {
    listingId: z.string().uuid().describe('The unique identifier of the listing'),
    checkIn: z.string().describe('Rental start date (ISO format)'),
    checkOut: z.string().describe('Rental end date (ISO format)'),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async ({ listingId, checkIn, checkOut }) => {
    if (!ctx.token) return requiresUser();
    const booking = await bookingTools.createBooking({
      listingId,
      checkIn,
      checkOut,
      token: ctx.token,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(booking, null, 2) }],
    };
  }
);

server.tool(
  'cancel_booking',
  {
    bookingId: z.string().uuid().describe('The unique identifier of the booking'),
  },
  { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  async ({ bookingId }) => {
    if (!ctx.token) return requiresUser();
    // The backend enforces ownership (renter/vendor) from the forwarded token
    // and handles any refund.
    const result = await bookingTools.cancelBooking(bookingId, ctx.token);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  'get_booking_status',
  {
    bookingId: z.string().uuid().describe('The unique identifier of the booking'),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ bookingId }) => {
    if (!ctx.token) return requiresUser();
    // GET /bookings/:id is ownership-gated server-side (renter/vendor/admin),
    // so the backend — not this layer — enforces who may see the booking.
    const status = await bookingTools.getBookingStatus(bookingId, ctx.token);
    return {
      content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
    };
  }
);

server.tool(
  'get_similar_listings',
  {
    listingId: z.string().uuid().describe('The unique identifier of the listing'),
    limit: z.number().optional().default(5),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ listingId, limit }) => {
    const results = await listingTools.getSimilarListings(listingId, limit);
    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  }
);

server.tool(
  'get_personalized_recommendations',
  {
    limit: z.number().min(1).max(50).optional().default(5),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ limit }) => {
    if (!ctx.token) return requiresUser();
    // The backend derives the user from the forwarded JWT (GET /ai/recommendations/for-me).
    const results = await listingTools.getPersonalizedRecommendations(ctx.token, limit);
    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  }
);

server.tool(
  'suggest_listing_price',
  {
    category: z.string().describe('The category of the gear'),
    location: z.string().optional().describe('Optional location for local market analysis'),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ category, location }) => {
    const results = await pricingTools.suggestListingPrice(category, location);
    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  }
);

server.tool(
  'analyze_competitor_pricing',
  {
    listingId: z.string().uuid().describe('The listing ID to analyze against competitors'),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ listingId }) => {
    const results = await pricingTools.analyzeCompetitorPricing(listingId);
    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  }
);

server.tool(
  'generate_listing_description',
  {
    name: z.string().describe('The name of the item'),
    category: z.string().describe('The category of the item'),
    keywords: z.array(z.string()).describe('List of key features or keywords'),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ name, category, keywords }) => {
    const description = await contentTools.generateListingDescription(name, category, keywords);
    return {
      content: [{ type: 'text', text: description }],
    };
  }
);

server.tool(
  'improve_listing_title',
  {
    currentTitle: z.string().describe('The current listing title'),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ currentTitle }) => {
    const optimizedTitle = await contentTools.improveListingTitle(currentTitle);
    return {
      content: [{ type: 'text', text: optimizedTitle }],
    };
  }
);

server.tool(
  'search_experiences',
  {
    location: z.string().optional().describe('City or neighborhood'),
    category: z.string().optional().describe('Category (Outdoor, Tours, Fitness, etc.)'),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ location, category }) => {
    const results = await experienceTools.searchExperiences({ location, category });
    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  }
);

server.tool(
  'get_experience_details',
  {
    experienceId: z.string().uuid().describe('The unique identifier of the experience'),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ experienceId }) => {
    const details = await experienceTools.getExperienceDetails(experienceId);
    return {
      content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
    };
  }
);

server.tool(
  'book_experience',
  {
    experienceId: z.string().uuid().describe('The experience to book'),
    scheduleId: z.string().uuid().optional().describe('Optional specific schedule/time slot'),
    guests: z.number().min(1).max(20).describe('Number of guests'),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async ({ experienceId, scheduleId, guests }) => {
    if (!ctx.token) return requiresUser();
    const booking = await experienceTools.bookExperience({
      experienceId,
      scheduleId,
      guests,
      token: ctx.token,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(booking, null, 2) }],
    };
  }
);

server.tool(
  'send_message',
  {
    recipientId: z.string().uuid().describe('The user ID of the recipient'),
    content: z.string().min(1).max(5000).describe('The message content'),
    conversationId: z.string().uuid().optional().describe('Optional conversation ID'),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async ({ recipientId, content, conversationId }) => {
    if (!ctx.token) return requiresUser();
    // The backend derives the sender from the forwarded token — never
    // caller-supplied (was an impersonation vector).
    const result = await messagingTools.sendMessage({ recipientId, content, conversationId, token: ctx.token });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  'get_conversations',
  {},
  { readOnlyHint: true, openWorldHint: true },
  async () => {
    if (!ctx.token) return requiresUser();
    const results = await messagingTools.getConversations(ctx.token);
    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  }
);

server.tool(
  'generate_ai_message_draft',
  {
    context: z.string().describe('Context for the message'),
    userRole: z.enum(['renter', 'vendor']).describe('Role of the sender'),
    tone: z.string().optional().default('professional'),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ context, userRole, tone }) => {
    const draft = await messagingTools.generateAIDraft(context, userRole, tone);
    return {
      content: [{ type: 'text', text: draft }],
    };
  }
);

server.resource(
  'listing-categories',
  'splitmygear://categories',
  { description: 'Available listing categories' },
  async (uri) => {
    return {
      contents: [{
        uri: uri.href,
        text: JSON.stringify([
          { id: 'camping', name: 'Camping', icon: '🏕️' },
          { id: 'hiking', name: 'Hiking', icon: '🥾' },
          { id: 'water', name: 'Water Sports', icon: '🚣' },
          { id: 'snow', name: 'Winter Sports', icon: '⛷️' },
          { id: 'climbing', name: 'Climbing', icon: '🧗' },
          { id: 'cycling', name: 'Cycling', icon: '🚴' },
          { id: 'fishing', name: 'Fishing', icon: '🎣' },
          { id: 'photography', name: 'Photography', icon: '📷' },
        ], null, 2),
      }],
    };
  }
);

  return server;
}

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return handleRequest(request);
}

export async function POST(request: NextRequest) {
  return handleRequest(request);
}

async function handleRequest(request: NextRequest) {
  try {
    const authResult = await authMiddleware(request);
    if (!authResult.success) {
      return new Response(JSON.stringify({ error: authResult.error }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const rateLimitResult = await rateLimiter(request, authResult.userId);
    if (!rateLimitResult.success) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Stateless: a brand-new server + transport per request (no session id),
    // with JSON responses enabled so a single POST completes the
    // initialize/tools-call round-trip without a persistent SSE session.
    const server = buildServer({ userId: authResult.userId, role: authResult.role, token: authResult.token });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  } catch (error) {
    console.error('MCP Server Error:', error);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
