/**
 * Tool registry: every MCP tool is declared once with `defineTool` — a name,
 * a model-facing title + description, an access level, a zod input shape,
 * MCP annotations, and a handler. `registerTools` then registers, on a fresh
 * per-request `McpServer`, exactly the tools the authenticated principal may
 * use, so `tools/list` is role-aware:
 *
 *   operator key  → `public` tools only (search, availability, pricing …)
 *   any user      → + `user` tools (profile, bookings, chat, reviews …)
 *   renter        → + `renter` tools (creating rental bookings — the backend's
 *                     POST /bookings is @Roles(RENTER))
 *   vendor family → + `vendor` tools (listings, calendar, incoming bookings …)
 *   owner/manager → + `vendor_finance` (earnings, payouts, Stripe status)
 *   owner         → + `vendor_owner` (Stripe Connect onboarding)
 *
 * Handlers are ALSO gated at call time (defense in depth) and the backend
 * re-checks authorization on every forwarded request — visibility is a UX
 * optimisation, never the security boundary.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape, ZodTypeAny, objectOutputType } from 'zod';
import type { PrincipalKind } from '@/middleware/auth';
import { canActAsVendor, canBookRentals, canManageVendorPayouts, canViewVendorFinance } from '@/lib/roles';

export type ToolAccess = 'public' | 'user' | 'renter' | 'vendor' | 'vendor_finance' | 'vendor_owner';

/**
 * OAuth scope a tool belongs to. A connection may be granted a subset of
 * scopes at sign-in; tools outside the granted set are neither listed nor
 * callable on that connection. Role/access checks still apply on top.
 */
export const TOOL_SCOPES = [
  'read',
  'profile',
  'bookings',
  'favorites',
  'messaging',
  'reviews',
  'listings',
  'vendor_bookings',
  'experiences',
  'finance',
  'claims',
  'files',
] as const;
export type ToolScope = (typeof TOOL_SCOPES)[number];

export interface ToolContext {
  userId?: string;
  role?: string;
  email?: string;
  /** Backend JWT to forward (absent for the operator key). */
  token?: string;
  kind?: PrincipalKind;
}

export interface ToolDef<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  access: ToolAccess;
  scope: ToolScope;
  inputSchema: Shape;
  annotations: ToolAnnotations;
  handler: (args: objectOutputType<Shape, ZodTypeAny>, ctx: ToolContext) => Promise<CallToolResult>;
}

/** Identity helper that pins the shape type so handlers get typed args. */
export function defineTool<Shape extends ZodRawShape>(def: ToolDef<Shape>): ToolDef<Shape> {
  return def;
}

export function isToolVisible(access: ToolAccess, ctx: ToolContext): boolean {
  switch (access) {
    case 'public':
      return true;
    case 'user':
      return !!ctx.token;
    case 'renter':
      return !!ctx.token && canBookRentals(ctx.role);
    case 'vendor':
      return !!ctx.token && canActAsVendor(ctx.role);
    case 'vendor_finance':
      return !!ctx.token && canViewVendorFinance(ctx.role);
    case 'vendor_owner':
      return !!ctx.token && canManageVendorPayouts(ctx.role);
  }
}

const ACCESS_DENIED: Record<Exclude<ToolAccess, 'public'>, string> = {
  user: 'This tool acts as a signed-in Splitt user. Connect with your Splitt account (OAuth) or a user Bearer token; the operator key cannot use it.',
  renter: 'Only renter accounts can create rental bookings on Splitt. Sign in with a renter account.',
  vendor: 'This tool is for Splitt vendors. Sign in with a vendor account (or apply to become a vendor at https://go-splitt.com/partners).',
  vendor_finance: 'Earnings and payout data are available to vendor owner/manager seats only.',
  vendor_owner: 'Only the vendor owner seat can manage Stripe Connect and payouts.',
};

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

export function fail(message: string, details?: unknown): CallToolResult {
  const text = details === undefined ? message : `${message}\n${JSON.stringify(details, null, 2)}`;
  return { isError: true, content: [{ type: 'text', text }] };
}

/** Map a `Result` from the shared backend wrapper to a tool result. */
export function fromResult<T>(result: { ok: true; data: T } | { ok: false; error: string; status?: number }, map?: (data: T) => unknown): CallToolResult {
  if (!result.ok) return fail(withStatusHint(result.error, result.status));
  return ok(map ? map(result.data) : result.data);
}

function withStatusHint(message: string, status?: number): string {
  if (status === 401) return `Splitt rejected the session (expired or revoked). Reconnect and try again. (${message})`;
  if (status === 403) return `Not allowed for this account: ${message}`;
  if (status === 404) return `Not found: ${message}`;
  if (status === 409) return `Conflict: ${message}`;
  if (status === 429) return `Splitt is rate limiting this action; wait a minute and retry. (${message})`;
  return message;
}

export function registerTools(server: McpServer, ctx: ToolContext, defs: ReadonlyArray<ToolDef<ZodRawShape>>): string[] {
  const registered: string[] = [];
  for (const def of defs) {
    if (!isToolVisible(def.access, ctx)) continue;
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: def.annotations,
      },
      async (args: objectOutputType<ZodRawShape, ZodTypeAny>) => {
        if (!isToolVisible(def.access, ctx)) {
          return fail(def.access === 'public' ? 'Not available' : ACCESS_DENIED[def.access]);
        }
        try {
          return await def.handler(args, ctx);
        } catch (error) {
          console.error(`[mcp] ${def.name} failed:`, error instanceof Error ? error.message : error);
          return fail(`${def.name} failed unexpectedly. Please try again.`);
        }
      },
    );
    registered.push(def.name);
  }
  return registered;
}

/** Widen a typed def to the registry's element type (keeps `defineTool` inference at the call site). */
export function toolList(...defs: Array<ToolDef<ZodRawShape>>): ToolDef<ZodRawShape>[] {
  return defs;
}
